
/**
 * Module dependencies.
 */

var net = require('net');
var tls = require('tls');
var parse = require('url').parse;
var format = require('url').format;
var extend = require('extend');
var getUri = require('get-uri');
var Agent = require('agent-base');
var ProxyAgent = require('proxy-agent');
var PacResolver = require('pac-resolver');
var toArray = require('stream-to-array');
var inherits = require('util').inherits;
var debug = require('debug')('pac-proxy-agent');

/**
 * Module exports.
 */

module.exports = exports = PacProxyAgent;

/**
 * Supported "protocols". Delegates out to the `get-uri` module.
 */

Object.defineProperty(exports, 'protocols', {
  enumerable: true,
  configurable: true,
  get: function () { return Object.keys(getUri.protocols); }
});

/**
 * The `PacProxyAgent` class.
 *
 * A few different "protocol" modes are supported (supported protocols are
 * backed by the `get-uri` module):
 *
 *   - "pac+data", "data" - refers to an embedded "data:" URI
 *   - "pac+file", "file" - refers to a local file
 *   - "pac+ftp", "ftp" - refers to a file located on an FTP server
 *   - "pac+http", "http" - refers to an HTTP endpoint
 *   - "pac+https", "https" - refers to an HTTPS endpoint
 *
 * Or you can pass the PAC file JS code directly as a `code` param in the options
 * object.
 *
 * @api public
 */

function PacProxyAgent (opts) {
  if (!(this instanceof PacProxyAgent)) return new PacProxyAgent(opts);
  var uri;
  if ('string' == typeof opts) {
    uri = opts;
  } else {
    if (opts.path && !opts.pathname) {
      opts.pathname = opts.path;
    }
    opts.slashes = true;
    uri = format(opts);
  }
  if (!uri) throw new Error('a PAC file location must be specified!');
  Agent.call(this, connect);

  // strip the "pac+" prefix
  this.uri = uri.replace(/^pac\+/i, '');

  /*
  if (opts.code) {
    // the JS code was passed directly in
    protocol = 'code';
    this.code = opts.code;
  }
  */
}
inherits(PacProxyAgent, Agent);

/**
 * Loads the PAC proxy file from the source if necessary, and returns
 * a generated `FindProxyForURL()` resolver function to use.
 *
 * @param {Function} fn callback function
 * @api private
 */

PacProxyAgent.prototype.loadResolver = function (fn) {
  var self = this;

  function onPacFile (err, code) {
    if (err) {
      if ('ENOTMODIFIED' == err.code) {
        debug('got ENOTMODIFIED response, reusing previous proxy resolver');
        fn(null, self._resolver);
      } else {
        fn(err);
      }
      return;
    }

    // cache the resolver
    debug('creating new proxy resolver instance');
    self._resolver = new PacResolver(code);
    fn(null, self._resolver);
  }

  // kick things off by checking if we need to regenerate the Resolver
  this.loadPacFile(onPacFile);
};

/**
 * Loads the contents of the PAC proxy file.
 *
 * @param {Function} fn callback function
 * @api private
 */

PacProxyAgent.prototype.loadPacFile = function (fn) {
  debug('loading PAC file: %j', this.uri);
  var self = this;

  if (this.code) {
    // code was directly passed in
    fn(null, this.code);
  } else {
    // delegate out to the `get-uri` module
    var opts = {};
    if (this.cache) {
      opts.cache = this.cache;
    }
    getUri(this.uri, opts, onstream);
  }

  function onstream (err, rs) {
    if (err) return fn(err);
    debug('got stream.Readable instance for URI');
    self.cache = rs;
    toArray(rs, onarray);
  }

  function onarray (err, arr) {
    if (err) return fn(err);
    var buf = Buffer.concat(arr);
    debug('read %d byte PAC file from URI', buf.length);
    fn(null, buf.toString('utf8'));
  }
};

/**
 * Called when the node-core HTTP client library is creating a new HTTP request.
 *
 * @api public
 */

function connect (req, opts, fn) {
  var url;
  var host;
  var self = this;

  // first we need get a generated FindProxyForURL() function,
  // either cached or retreived from the source
  this.loadResolver(onresolver);

  // `loadResolver()` callback function
  function onresolver (err, FindProxyForURL) {
    if (err) return fn(err);

    // calculate the `url` parameter
    url = format(extend({}, opts, {
      protocol: self.secureEndpoint ? 'https:' : 'http:',
      pathname: req.path,

      // XXX: need to use `hostname` instead of `host` otherwise `port` is not used
      hostname: opts.host,
      host: null
    }));

    // calculate the `host` parameter
    host = parse(url).hostname;

    debug('url: %j, host: %j', url, host);
    FindProxyForURL(url, host, onproxy);
  }

  // `FindProxyForURL()` callback function
  function onproxy (err, proxy) {
    if (err) return fn(err);
    var proxies = proxy.split(/;\s*?\b/);

    // XXX: right now, only the first proxy specified will be used
    var first = proxies[0];
    debug('using proxy: "%s"', first);

    var parts = first.split(/\s+/);
    var type = parts[0];
    var agent;

    if ('DIRECT' == type) {
      // direct connection to the destionation endpoint
      var socket;
      if (self.secureEndpoint) {
        socket = tls.connect(opts);
      } else {
        socket = net.connect(opts);
      }
      return fn(null, socket);
    } else if ('PROXY' == type) {
      // use an HTTP proxy
      agent = ProxyAgent('http://' + parts[1], self.secureEndpoint);
    } else if ('SOCKS' == type) {
      // use a SOCKS proxy
      agent = ProxyAgent('socks://' + parts[1], self.secureEndpoint);
    }
    if (agent) agent.callback(req, opts, fn);
  }
}
