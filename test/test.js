
/**
 * Module dependencies.
 */

var fs = require('fs');
var url = require('url');
var http = require('http');
var https = require('https');
var assert = require('assert');
var toBuffer = require('stream-to-buffer');
var Proxy = require('proxy');
var socks = require('socksv5');
var PacProxyAgent = require('../');
try {
  var Kerberos = require('kerberos');
} catch(er) {
  Kerberos = null;
}


describe('PacProxyAgent', function () {
  // target servers
  var httpServer, httpPort;
  var httpsServer, httpsPort;

  // proxy servers
  var socksServer, socksPort;
  var proxyServer, proxyPort;
  var proxyHttpsServer, proxyHttpsPort;

  before(function (done) {
    // setup target HTTP server
    httpServer = http.createServer();
    httpServer.listen(function () {
      httpPort = httpServer.address().port;
      done();
    });
  });

  before(function (done) {
    // setup target SSL HTTPS server
    var options = {
      key: fs.readFileSync(__dirname + '/ssl-cert-snakeoil.key'),
      cert: fs.readFileSync(__dirname + '/ssl-cert-snakeoil.pem')
    };
    httpsServer = https.createServer(options);
    httpsServer.listen(function () {
      httpsPort = httpsServer.address().port;
      done();
    });
  });

  before(function (done) {
    // setup SOCKS proxy server
    socksServer = socks.createServer(function(info, accept, deny) {
      accept();
    });
    socksServer.listen(function() {
      socksPort = socksServer.address().port;
      done();
    });
    socksServer.useAuth(socks.auth.None());
  });

  before(function (done) {
    // setup HTTP proxy server
    proxyServer = Proxy();
    proxyServer.listen(function () {
      proxyPort = proxyServer.address().port;
      done();
    });
  });

  before(function (done) {
    // setup SSL HTTPS proxy server
    var options = {
      key: fs.readFileSync(__dirname + '/ssl-cert-snakeoil.key'),
      cert: fs.readFileSync(__dirname + '/ssl-cert-snakeoil.pem')
    };
    proxyHttpsServer = Proxy(https.createServer(options));
    proxyHttpsServer.listen(function () {
      proxyHttpsPort = proxyHttpsServer.address().port;
      done();
    });
  });


  after(function (done) {
    socksServer.once('close', function () { done(); });
    socksServer.close();
  });

  after(function (done) {
    httpServer.once('close', function () { done(); });
    httpServer.close();
  });

  after(function (done) {
    httpsServer.once('close', function () { done(); });
    httpsServer.close();
  });

  after(function (done) {
    proxyServer.once('close', function () { done(); });
    proxyServer.close();
  });

  after(function (done) {
    proxyHttpsServer.once('close', function () { done(); });
    proxyHttpsServer.close();
  });

  describe('constructor', function () {
    it('should accept a "string" proxy argument', function () {
      var agent = new PacProxyAgent('pac+ftp://example.com/proxy.pac');
      assert.equal('ftp://example.com/proxy.pac', agent.uri);
    });
    it('should accept a `url.parse()` result object argument', function () {
      var opts = url.parse('pac+ftp://example.com/proxy.pac');
      var agent = new PacProxyAgent(opts);
      assert.equal('ftp://example.com/proxy.pac', agent.uri);
    });
    it('should accept a `uri` on the options object', function () {
      var agent = new PacProxyAgent({ uri: 'pac+ftp://example.com/proxy.pac' });
      assert.equal('ftp://example.com/proxy.pac', agent.uri);
    });
  });

  describe('"http" module', function () {
    it('should work over an HTTP proxy', function (done) {
      httpServer.once('request', function (req, res) {
        res.end(JSON.stringify(req.headers));
      });

      function FindProxyForURL(url, host) {
        return "PROXY 127.0.0.1:PORT;"
      }

      var uri = 'data:,' + encodeURIComponent(FindProxyForURL.toString().replace('PORT', proxyPort));
      var agent = new PacProxyAgent(uri);

      var opts = url.parse('http://127.0.0.1:' + httpPort + '/test');
      opts.agent = agent;

      var req = http.get(opts, function (res) {
        toBuffer(res, function (err, buf) {
          if (err) return done(err);
          var data = JSON.parse(buf.toString('utf8'));
          assert.equal('127.0.0.1:' + httpPort, data.host);
          assert('via' in data);
          done();
        });
      });
      req.once('error', done);
    });

    it('should work over an HTTPS proxy', function (done) {
      httpServer.once('request', function (req, res) {
        res.end(JSON.stringify(req.headers));
      });

      function FindProxyForURL(url, host) {
        return "HTTPS 127.0.0.1:PORT;"
      }

      var uri = 'data:,' + encodeURIComponent(FindProxyForURL.toString().replace('PORT', proxyHttpsPort));
      var proxy = url.parse(uri);
      proxy.rejectUnauthorized = false;
      var agent = new PacProxyAgent(proxy);

      var opts = url.parse('http://127.0.0.1:' + httpPort + '/test');
      opts.agent = agent;

      var req = http.get(opts, function (res) {
        toBuffer(res, function (err, buf) {
          if (err) return done(err);
          var data = JSON.parse(buf.toString('utf8'));
          assert.equal('127.0.0.1:' + httpPort, data.host);
          assert('via' in data);
          done();
        });
      });
      req.once('error', done);
    });

    it('should work over a SOCKS proxy', function (done) {
      httpServer.once('request', function (req, res) {
        res.end(JSON.stringify(req.headers));
      });

      function FindProxyForURL(url, host) {
        return "SOCKS 127.0.0.1:PORT;"
      }

      var uri = 'data:,' + encodeURIComponent(FindProxyForURL.toString().replace('PORT', socksPort));
      var agent = new PacProxyAgent(uri);

      var opts = url.parse('http://127.0.0.1:' + httpPort + '/test');
      opts.agent = agent;

      var req = http.get(opts, function (res) {
        toBuffer(res, function (err, buf) {
          if (err) return done(err);
          var data = JSON.parse(buf.toString('utf8'));
          assert.equal('127.0.0.1:' + httpPort, data.host);
          done();
        });
      });
      req.once('error', done);
    });

    describe('autodetection', function() {
      var tests = [
	['should do proxy autodetection', function(done) {
	  var agent = new PacProxyAgent();
	  if(Kerberos) {
	    agent.proxy.use_kerberos = 1;
	  }
	  var opts = url.parse('http://www.nodejs.org/');
	  opts.agent = agent;

	  var req = http.get(opts, function (res) {
            toBuffer(res, function (err) {
	      assert.equal(302, res.statusCode);
              if (err) return done(err);
              done();
            });
	  });
	  req.once('error', done);
	}]
      ];

      tests.forEach(function(test) {
	if(process.env.USE_PROXY_AUTODETECT) {
	  it(test[0], test[1]);
	} else {
	  it.skip(test[0], test[1]);
	}
      });
    });
  });


  describe('"https" module', function () {
    it('should work over an HTTP proxy', function (done) {
      httpsServer.once('request', function (req, res) {
        res.end(JSON.stringify(req.headers));
      });

      function FindProxyForURL(url, host) {
        return "PROXY 127.0.0.1:PORT;"
      }

      var uri = 'data:,' + encodeURIComponent(FindProxyForURL.toString().replace('PORT', proxyPort));
      var agent = new PacProxyAgent(uri);

      var opts = url.parse('https://127.0.0.1:' + httpsPort + '/test');
      opts.agent = agent;
      opts.rejectUnauthorized = false;

      var req = https.get(opts, function (res) {
        toBuffer(res, function (err, buf) {
          if (err) return done(err);
          var data = JSON.parse(buf.toString('utf8'));
          assert.equal('127.0.0.1:' + httpsPort, data.host);
          done();
        });
      });
      req.once('error', done);
    });

    it('should work over an HTTPS proxy', function (done) {
      var gotReq = false;
      httpsServer.once('request', function (req, res) {
        gotReq = true;
        res.end(JSON.stringify(req.headers));
      });

      function FindProxyForURL(url, host) {
        return "HTTPS 127.0.0.1:PORT;"
      }

      var uri = 'data:,' + encodeURIComponent(FindProxyForURL.toString().replace('PORT', proxyHttpsPort));
      var agent = new PacProxyAgent(uri, {
        rejectUnauthorized: false
      });

      var opts = url.parse('https://127.0.0.1:' + httpsPort + '/test');
      opts.agent = agent;
      opts.rejectUnauthorized = false;

      var req = https.get(opts, function (res) {
        toBuffer(res, function (err, buf) {
          if (err) return done(err);
          var data = JSON.parse(buf.toString('utf8'));
          assert.equal('127.0.0.1:' + httpsPort, data.host);
          assert(gotReq);
          done();
        });
      });
      req.once('error', done);
    });

    it('should work over a SOCKS proxy', function (done) {
      var gotReq = false;
      httpsServer.once('request', function (req, res) {
        gotReq = true;
        res.end(JSON.stringify(req.headers));
      });

      function FindProxyForURL(url, host) {
        return "SOCKS 127.0.0.1:PORT;"
      }

      var uri = 'data:,' + encodeURIComponent(FindProxyForURL.toString().replace('PORT', socksPort));
      var agent = new PacProxyAgent(uri);

      var opts = url.parse('https://127.0.0.1:' + httpsPort + '/test');
      opts.agent = agent;
      opts.rejectUnauthorized = false;

      var req = https.get(opts, function (res) {
        toBuffer(res, function (err, buf) {
          if (err) return done(err);
          var data = JSON.parse(buf.toString('utf8'));
          assert.equal('127.0.0.1:' + httpsPort, data.host);
          assert(gotReq);
          done();
        });
      });
      req.once('error', done);
    });
  });

});
