'use strict';

require('parsoid/core-upgrade.js');

var parseJs = require('parsoid/lib/parse.js');

var json = require('./package.json');
var JsApi = require('./jsapi.js');

/**
 * Main entry point for Parsoid's JavaScript API.
 *
 * Note that Parsoid's main interface is actually a web API, as
 * defined by {@link ParsoidService}.
 *
 * But some users would like to use Parsoid as a NPM package using
 * a native JavaScript API.  This file provides that, more-or-less.
 * It should be considered unstable.  Patches welcome.
 *
 * See `./jsapi.js` for a useful wrapper API which works
 * well with this interface.
 *
 * @namespace
 */
var Parsoid = module.exports = {
	/** Name of the NPM package. */
	name: json.name,
	/** Version of the NPM package. */
	version: json.version,
};

/**
 * Parse wikitext (or html) to html (or wikitext).
 *
 * Sample usage:
 *
 *     Parsoid.parse('hi there', { document: true }).then(function(res) {
 *        console.log(res.out.outerHTML);
 *     }).done();
 *
 * Advanced usage using the {@link PDoc} API:
 *
 *     Parsoid.parse('{{echo|hi}}', { pdoc: true }).then(function(pdoc) {
 *        var templates = pdoc.filterTemplates();
 *        console.log(templates[0].name);
 *     }).done();
 *
 * @param {string} input
 *    The input wikitext or HTML (depending on conversion direction).
 * @param {Object} options
 * @param {boolean} [options.document=false]
 *    Return a DOM {@link Document} (instead of a string)
 * @param {boolean} [options.pdoc=false]
 *    Return a {@link PDoc} object (instead of a string)
 * @param {boolean} [options.wt2html=true]
 *    Convert wikitext to HTML.
 * @param {boolean} [options.html2wt=false]
 *    Convert HTML to wikitext.
 * @param {ParsoidConfig} [options.parsoidConfig]
 *    A {@link ParsoidConfig} object to use during parsing.
 *    If not provided one will be constructed using `options.config`.
 * @return {Promise}
 *   Fulfilled with the result of the parse.
 */
Parsoid.parse = function(input, options, optCb) {
	var argv = Object.assign({}, {
		/* default options */
	}, options || {});

	if (argv.pdoc) {
		argv.document = true;
	}

	if (argv.selser) {
		argv.html2wt = true;
	}

	// Default conversion mode
	if (!argv.html2wt && !argv.wt2wt && !argv.html2html) {
		argv.wt2html = true;
	}

	return parseJs({
		input: input || '',
		mode: (
			argv.wt2html ? 'wt2html' :
			argv.html2wt ? 'html2wt' :
			argv.html2html ? 'html2html' :
			argv.wt2wt ? 'wt2wt' :
			'<unknown mode>'
		),
		parsoidOptions: Object.assign({
			useWorker: false,
			addHTMLTemplateParameters: true,
			loadWMF: true,
		}, options.parsoidOptions || {}),
		envOptions: Object.assign({
			domain: argv.domain || 'en.wikipedia.org',
			pageName: argv.pageName,
			wrapSections: true,
		}, options.envOptions || {}),
		returnDocument: argv.pdoc || argv.document,
	}).then(function(res) {
		// The ability to return as an HTML Document used to be in core :(
		return argv.pdoc ? new JsApi.PDoc(res.env, res.doc) : res;
	}).nodify(optCb);
};

// Add a helper method to PNodeList, based on Parsoid.parse.

/**
 * Create a {@link PNodeList} belonging to the given {@link PDoc}
 * from a string containing wikitext.
 * @param {PDoc} pdoc
 *   The {@link PDoc} which will own the result.
 * @param {string} wikitext
 *   The wikitext to convert.
 * @param {Object} options
 *   Options which are passed to {@link Parsoid#parse}.
 * @return {Promise}
 *    Fulfilled by a {@link PNodeList} representing the given wikitext.
 * @static
 */
JsApi.PNodeList.fromWikitext = function(pdoc, wikitext, options) {
	options = Object.assign({}, options, { pdoc: true });
	return Parsoid.parse(wikitext, options).then(function(pdoc2) {
		var node = pdoc.document.adoptNode(pdoc2.document.body);
		return new JsApi.PNodeList(pdoc, null, node);
	});
};

// Expose other helpful objects.
Object.keys(JsApi).forEach(function(k) {
	Parsoid[k] = JsApi[k];
});
