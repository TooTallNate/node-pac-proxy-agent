import net from 'net';
import tls from 'tls';
import crypto from 'crypto';
import getUri from 'get-uri';
import createDebug from 'debug';
import getRawBody from 'raw-body';
import { Readable } from 'stream';
import { format, parse } from 'url';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import createPacResolver, { FindProxyForURL } from 'pac-resolver';
import { Agent, ClientRequest, RequestOptions } from 'agent-base';
import { PacProxyAgentOptions } from '.';

const debug = createDebug('pac-proxy-agent');

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
 * @api public
 */
export default class PacProxyAgent extends Agent {
	uri: string;
	opts: PacProxyAgentOptions;
	cache?: Readable;
	resolver?: FindProxyForURL;
	resolverHash: string;

	constructor(uri: string, opts: PacProxyAgentOptions = {}) {
		super(opts);
		debug('Creating PacProxyAgent with URI %o and options %o', uri, opts);

		// Strip the "pac+" prefix
		this.uri = uri.replace(/^pac\+/i, '');
		this.opts = { ...opts };
		this.cache = undefined;
		this.resolver = undefined;
		this.resolverHash = '';

		// For `PacResolver`
		if (!this.opts.filename) {
			this.opts.filename = uri;
		}
	}

	/**
	 * Loads the PAC proxy file from the source if necessary, and returns
	 * a generated `FindProxyForURL()` resolver function to use.
	 *
	 * @param {Function} fn callback function
	 * @api private
	 */
	private async loadResolver(): Promise<FindProxyForURL> {
		try {
			// (Re)load the contents of the PAC file URI
			const code = await this.loadPacFile();

			// Create a sha1 hash of the JS code
			const hash = crypto
				.createHash('sha1')
				.update(code)
				.digest('hex');

			if (this.resolver && this.resolverHash === hash) {
				debug(
					'Same sha1 hash for code - contents have not changed, reusing previous proxy resolver'
				);
				return this.resolver;
			}

			// Cache the resolver
			debug('Creating new proxy resolver instance');
			this.resolver = createPacResolver(code, this.opts);

			// Store that sha1 hash on the resolver instance
			// for future comparison purposes
			this.resolverHash = hash;

			return this.resolver;
		} catch (err) {
			if (this.resolver && err.code === 'ENOTMODIFIED') {
				debug(
					'Got ENOTMODIFIED response, reusing previous proxy resolver'
				);
				return this.resolver;
			}
			throw err;
		}
	}

	/**
	 * Loads the contents of the PAC proxy file.
	 *
	 * @param {Function} fn callback function
	 * @api private
	 */
	private async loadPacFile(): Promise<string> {
		debug('Loading PAC file: %o', this.uri);

		const rs = await getUri(this.uri, { cache: this.cache });
		debug('Got `Readable` instance for URI');
		this.cache = rs;

		const buf = await getRawBody(rs);
		debug('Read %o byte PAC file from URI', buf.length);

		return buf.toString('utf8');
	}

	/**
	 * Called when the node-core HTTP client library is creating a new HTTP request.
	 *
	 * @api protected
	 */
	async callback(
		req: ClientRequest,
		opts: RequestOptions
	): Promise<net.Socket | Agent> {
		const { secureEndpoint } = opts;

		// First, get a generated `FindProxyForURL()` function,
		// either cached or retreived from the source
		const resolver = await this.loadResolver();

		// Calculate the `url` parameter
		const defaultPort = secureEndpoint ? 443 : 80;
		let path = req.path;
		let search: string | null = null;
		let firstQuestion = path.indexOf('?');
		if (firstQuestion !== -1) {
			search = path.substring(firstQuestion);
			path = path.substring(0, firstQuestion);
		}

		const urlOpts = {
			...opts,
			protocol: secureEndpoint ? 'https:' : 'http:',
			pathname: path,
			search,

			// need to use `hostname` instead of `host` otherwise `port` is ignored
			hostname: opts.host,
			host: null,
			href: null,

			// set `port` to null when it is the protocol default port (80 / 443)
			port: defaultPort === opts.port ? null : opts.port
		};
		const url = format(urlOpts);

		debug('url: %o', url);
		let result = await resolver(url);

		// Default to "DIRECT" if a falsey value was returned (or nothing)
		if (!result) {
			result = 'DIRECT';
		}

		const proxies = String(result)
			.trim()
			.split(/\s*;\s*/g)
			.filter(Boolean);

		// XXX: right now, only the first proxy specified will be used
		const first = proxies[0];
		debug('using proxy: %o', first);

		const parts = first.split(/\s+/);
		const type = parts[0];

		if (type === 'DIRECT') {
			// Direct connection to the destination endpoint
			if (secureEndpoint) {
				return tls.connect(opts);
			}
			return net.connect(opts);
		}

		if (type === 'SOCKS') {
			// Use a SOCKS proxy
			return new SocksProxyAgent(`socks://${parts[1]}`);
		}

		if (type === 'PROXY' || type === 'HTTPS') {
			// Use an HTTP or HTTPS proxy
			// http://dev.chromium.org/developers/design-documents/secure-web-proxy
			const proxyURL = `${type === 'HTTPS' ? 'https' : 'http'}://${
				parts[1]
			}`;
			const proxyOpts = { ...this.opts, ...parse(proxyURL) };
			if (secureEndpoint) {
				return new HttpsProxyAgent(proxyOpts);
			}
			return new HttpProxyAgent(proxyOpts);
		}

		throw new Error(`Unknown proxy type: ${type}`);
	}
}
