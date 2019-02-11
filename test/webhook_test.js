var helper = require('./test_helper');
var assert = require('assert');
var http = require('http');
var express = require('express');
var bodyParser = require('body-parser');
var app = express();
var ac = require('../index');
var request = require('request');
var logger = require('./logger');
var jwt = require('atlassian-jwt');
var sinon = require("sinon");
var moment = require("moment");
var addon = {};

describe('Webhook', function () {
    var server;
    var hostServer;
    var addonRegistered = false;

    before(function (done) {
        ac.store.register("teststore", function (logger, opts) {
            return require("../lib/store/sequelize")(logger, opts);
        });

        app.set('env', 'development');
        app.use(bodyParser.urlencoded({extended: false}));
        app.use(bodyParser.json());

        var installedPayload = helper.installedPayload;
        installedPayload.baseUrl = "http://admin:admin@localhost:3003";

        addon = ac(app, {
            config: {
                development: {
                    store: {
                        adapter: "teststore",
                        type: "memory"
                    },
                    hosts: [ installedPayload.baseUrl ]
                }
            }
        }, logger);


        var host = express();
        // mock host
        host.get("/rest/plugins/1.0/", function(req, res) {
            res.setHeader("upm-token", "123");
            res.json({plugins: []});
        });

        host.post("/rest/plugins/1.0/", function (req, res) {
            request({
                url: helper.addonBaseUrl + '/installed',
                qs: {
                    jwt: createValidJwtToken()
                },
                method: 'POST',
                json: installedPayload
            });
            res.status(200).end();
        });

        hostServer = http.createServer(host).listen(3003, function () {
            server = http.createServer(app).listen(helper.addonPort, function () {
                addon.once('host_settings_saved', function () {
                    addonRegistered = true;
                });
                addon.register().then(done);
            });
        });
    });

    after(function (done) {
        server.close();
        hostServer.close();
        done();
    });

    function createValidJwtToken(req) {
        var jwtPayload = {
            "iss": helper.installedPayload.clientKey,
            "iat": moment().utc().unix(),
            "exp": moment().utc().add(10, 'minutes').unix()
        };

        if (req) {
            jwtPayload.qsh = jwt.createQueryStringHash(jwt.fromExpressRequest(req));
        }

        return jwt.encode(jwtPayload, helper.installedPayload.sharedSecret);
    }

    function createExpiredJwtToken(req) {
        var jwtPayload = {
            "iss": helper.installedPayload.clientKey,
            "iat": moment().utc().subtract(20, 'minutes').unix(),
            "exp": moment().utc().subtract(10, 'minutes').unix()
        };

        if (req) {
            jwtPayload.qsh = jwt.createQueryStringHash(jwt.fromExpressRequest(req));
        }

        return jwt.encode(jwtPayload, helper.installedPayload.sharedSecret);
    }

    function fireTestWebhook(route, body, assertWebhookResult, createJwtToken) {
        var url = helper.addonBaseUrl + route;

        var waitForRegistrationThenFireWebhook = function () {
            if (addonRegistered) {
                fireWebhook();
            } else {
                setTimeout(waitForRegistrationThenFireWebhook, 50);
            }
        };

        var requestMock = {
            method: 'post',
            path: route,
            query: {
                "user_id": "admin"
            }
        };

        var fireWebhook = function () {
            request.post({
                url: url,
                qs: {
                    "user_id": "admin",
                    "jwt": createJwtToken ? createJwtToken(requestMock) : createValidJwtToken(requestMock)
                },
                json: body
            }, assertWebhookResult);
        };

        waitForRegistrationThenFireWebhook();
    }

    function assertCorrectWebhookResult(err, res, body) {
        assert.equal(err, null);
        assert.equal(res.statusCode, 204, res.body);
    }

    it('should fire an add-on event', function (done) {
        addon.once('plugin_test_hook', function (event, body, req) {
            assert(event === 'plugin_test_hook');
            assert(body != null && body.foo === 'bar');
            assert(req && req.query['user_id'] === 'admin');
            done();
        });

        fireTestWebhook('/test-hook', {foo: 'bar'}, assertCorrectWebhookResult);
    });

    it('should perform auth verification for webhooks', function (done) {
        var triggered = sinon.spy();
        addon.once('webhook_auth_verification_triggered', triggered);
        var successful = sinon.spy();
        addon.once('webhook_auth_verification_successful', successful);

        addon.once('plugin_test_hook', function (key, body, req) {
            assert(triggered.called);
            assert(successful.called);
            done();
        });

        fireTestWebhook('/test-hook', {foo: 'bar'}, assertCorrectWebhookResult);
    });

    it('webhook with expired JWT claim should not be processed', function (done) {
        var triggered = sinon.spy();
        var successful = sinon.spy();
        var failed = sinon.spy();
        addon.once('webhook_auth_verification_triggered', triggered);
        addon.once('webhook_auth_verification_successful', successful);
        addon.once('webhook_auth_verification_failed', failed);

        addon.once('plugin_test_hook', function (key, body, req) {
            assert(triggered.called);
            assert(!successful.called);
            assert(failed.called);
        });

        fireTestWebhook('/test-hook', {foo: 'bar'}, function assertCorrectWebhookResult(err, res, body) {
            assert.equal(err, null);
            assert.equal(res.statusCode, 401, 'Status code for invalid token should be 401');
            assert.equal(body.message, 'Authentication request has expired. Try reloading the page.', 'Authentication expired error should be returned');
            done();
        }, createExpiredJwtToken);
    });

});
