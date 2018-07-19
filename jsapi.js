/**
 * Handy JavaScript API for Parsoid DOM, inspired by the
 * python `mwparserfromhell` package.
 * @module
 */

'use strict';

require('parsoid/core-upgrade.js');

// TO DO:
// extension
// PExtLink#url PWikiLink#title should handle mw:ExpandedAttrs

const DOMImpl = require('domino').impl;
const { Node, NodeFilter } = DOMImpl;
const DU = require('parsoid/lib/utils/DOMUtils.js').DOMUtils;
const Promise = require('parsoid/lib/utils/promise.js');

// Note that the JSAPI exposes data-mw directly as a DOM attribute to
// allow clients to easily edit it.

// WTS helper
const wts = Promise.async(function *(env, nodes) {
	let body;
	if (nodes.length === 0) {
		return '';
	} else if (nodes.length === 1 && DU.isBody(nodes[0])) {
		body = nodes[0];
	} else {
		body = nodes[0].ownerDocument.createElement('body');
		for (var i = 0; i < nodes.length; i++) {
			body.appendChild(nodes[i].cloneNode(true));
		}
	}
	return (yield env.getContentHandler().fromHTML(env, body, false));
});

// toString helper
const toStringHelper = function(nodes, sizeLimit) {
	let out;
	if (sizeLimit === undefined) { sizeLimit = 80; /* characters */ }
	if (nodes.length === 0) {
		return '';
	} else if (nodes.length === 1) {
		const body = nodes[0].ownerDocument.createElement('body');
		body.appendChild(nodes[0].cloneNode(true));
		out = DU.normalizeOut(body, 'parsoidOnly');
		if (out.length <= sizeLimit || !DU.isElt(nodes[0])) { return out; }
		body.firstChild.innerHTML = '...';
		out = DU.normalizeOut(body, 'parsoidOnly');
		if (out.length <= sizeLimit) { return out; }
		const name = nodes[0].nodeName.toLowerCase();
		const children = nodes[0].childNodes;
		if (children.length === 0) {
			return '<' + name + ' .../>';
		} else {
			return '<' + name + ' ...>...</' + name + '>';
		}
	} else {
		out = '';
		for (let i = 0; i < nodes.length; i++) {
			out += toStringHelper(
				[nodes[i]],
				(sizeLimit - out.length) / (nodes.length - i)
			);
		}
		return out;
	}
};

// HTML escape helper
const toHtmlStr = function(node, v) {
	if (typeof v === 'string') {
		const div = node.ownerDocument.createElement('div');
		div.textContent = v;
		return div.innerHTML;
	} else if (v instanceof PNodeList) {
		return v.container.innerHTML;
	} else {
		return v.outerHTML;
	}
};


/**
 * The PNodeList class wraps a collection of DOM {@link Node}s.
 * It provides methods that can be used to extract data from or
 * modify the nodes.  The `filter()` series of functions is very
 * useful for extracting and iterating over, for example, all
 * of the templates in the project (via {@link #filterTemplates}).
 * @class PNodeList
 * @constructor
 * @private
 * @param {PDoc} pdoc The parent document for this {@link PNodeList}.
 * @param {PNode|null} parent A {@link PNode} which will receive updates
 *    when this {@link PNodeList} is mutated.
 * @param {Node} container A DOM {@link Node} which is the parent of all
 *    of the DOM {@link Node}s in this {@link PNodeList}.  The container
 *    element itself is *not* considered part of the list.
 * @param {Object} [opts]
 * @param {Function} [opts.update]
 *    A function which will be invoked when {@link #update} is called.
 */
class PNodeList {
	constructor(pdoc, parent, container, opts) {
		this.pdoc = pdoc;
		this.parent = parent;
		this.container = container;
		this._update = (opts && opts.update);
		this._cachedPNodes = null;
	}

	/**
	 * Returns an {@link Array} of the DOM {@link Node}s represented
	 * by this {@link PNodeList}.
	 * @prop {Node[]}
	 */
	get nodes() {
		return Array.from(this.container.childNodes);
	}

	/**
	 * Call {@link #update} after manually mutating any of the DOM
	 * {@link Node}s represented by this {@link PNodeList} in order to
	 * ensure that any containing templates are refreshed with their
	 * updated contents.
	 *
	 * The mutation methods in the {@link PDoc}/{@link PNodeList} API
	 * automatically call {@link #update} for you when required.
	 */
	update() {
		this._cachedPNodes = null;
		if (this._update) { this._update(); }
		if (this.parent) { this.parent.update(); }
	}

	_querySelectorAll(selector) {
		const tweakedSelector = ',' + selector + ',';
		if (!(/,(COMMENT|TEXT),/.test(tweakedSelector))) {
			// Use fast native querySelectorAll
			return Array.from(this.container.querySelectorAll(selector));
		}
		// Implement comment/text node selector the hard way
		/* eslint-disable no-bitwise */
		let whatToShow = NodeFilter.SHOW_ELEMENT; // always show templates
		if (/,COMMENT,/.test(tweakedSelector)) {
			whatToShow |= NodeFilter.SHOW_COMMENT;
		}
		if (/,TEXT,/.test(tweakedSelector)) {
			whatToShow |= NodeFilter.SHOW_TEXT;
		}
		/* eslint-enable no-bitwise */
		const nodeFilter = (node) => {
			if (node.nodeType !== Node.ELEMENT_NODE) {
				return NodeFilter.FILTER_ACCEPT;
			}
			if (node.matches(PTemplate._selector)) {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		};
		const result = [];
		const includeTemplates =
			/,\[typeof~="mw:Transclusion"\],/.test(tweakedSelector);
		const treeWalker = this.pdoc.document.createTreeWalker(
			this.container, whatToShow, nodeFilter, false
		);
		while (treeWalker.nextNode()) {
			const node = treeWalker.currentNode;
			// We don't need the extra test for ELEMENT_NODEs yet, since
			// non-template element nodes will be skipped by the nodeFilter
			// above. But if we ever extend filter() to be fully generic,
			// we might need the commented-out portion of this test.
			if (
				node.nodeType === Node.ELEMENT_NODE /* &&
				node.matches(PTemplate._selector) */
			) {
				treeWalker.lastChild(); // always skip over all children
				if (!includeTemplates) {
					continue; // skip template itself
				}
			}
			result.push(node);
		}
		return result;
	}
	_templatesForNode(node) {
		// each Transclusion node could represent multiple templates.
		const parent = this;
		const result = [];
		const parts = DU.getJSONAttribute(node, 'data-mw', {}).parts || [];
		parts.forEach((part, i) => {
			if (part.template) {
				result.push(new PTemplate(parent.pdoc, parent, node, i));
			}
		});
		return result;
	}

	/**
	 * @private
	 * @param {Array} result
	 *   A result array to append new items to as they are found
	 * @param {string} selector
	 *   CSS-style selector for the nodes of interest
	 * @param {Function} func
	 *    Function to apply to every non-template match
	 * @param {Object} [opts]
	 * @param {boolean} [opts.recursive]
	 *    Set to `false` to avoid recursing into templates.
	 */
	_filter(result, selector, func, opts) {
		const recursive = (opts && opts.recursive) !== false;
		let tSelector = PTemplate._selector;
		if (selector) {
			tSelector += ',' + selector;
		}
		this._querySelectorAll(tSelector).forEach((node) => {
			const isTemplate = node.nodeType === Node.ELEMENT_NODE &&
				node.matches(PTemplate._selector);
			if (isTemplate) {
				this._templatesForNode(node).forEach((t) => {
					if (!selector) {
						result.push(t);
					}
					if (recursive) {
						t.params.forEach((k) => {
							const td = t.get(k);
							['key', 'value'].forEach((prop) => {
								if (td[prop]) {
									td[prop]._filter(result, selector, func, opts);
								}
							});
						});
					}
				});
			} else {
				func(result, this, node, opts);
			}
		});
		return result;
	}

	/**
	 * Return an array of {@link PComment} representing comments
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PComment[]}
	 */
	filterComments(opts) {
		return this._filter([], PComment._selector, (r, parent, node) => {
			r.push(new PComment(parent.pdoc, parent, node));
		}, opts);
	}

	/**
	 * Return an array of {@link PExtLink} representing external links
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PExtLink[]}
	 */
	filterExtLinks(opts) {
		return this._filter([], PExtLink._selector, (r, parent, node) => {
			r.push(new PExtLink(parent.pdoc, parent, node));
		}, opts);
	}

	/**
	 * Return an array of {@link PHeading} representing headings
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PHeading[]}
	 */
	filterHeadings(opts) {
		return this._filter([], PHeading._selector, (r, parent, node) => {
			r.push(new PHeading(parent.pdoc, parent, node));
		}, opts);
	}

	/**
	 * Return an array of {@link PHtmlEntity} representing HTML entities
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PHtmlEntity[]}
	 */
	filterHtmlEntities(opts) {
		return this._filter([], PHtmlEntity._selector, (r, parent, node) => {
			r.push(new PHtmlEntity(parent.pdoc, parent, node));
		}, opts);
	}

	/**
	 * Return an array of {@link PMedia} representing images or other
	 * media content found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PMedia[]}
	 */
	filterMedia(opts) {
		return this._filter([], PMedia._selector, (r, parent, node) => {
			r.push(new PMedia(parent.pdoc, parent, node));
		}, opts);
	}

	/**
	 * Return an array of {@link PSection} representing sections
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PSection[]}
	 */
	filterSections(opts) {
		return this._filter([], PSection._selector, (r, parent, node) => {
			r.push(new PSection(parent.pdoc, parent, node));
		}, opts);
	}

	/**
	 * Return an array of {@link PTemplate} representing templates
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PTemplate[]}
	 */
	filterTemplates(opts) {
		return this._filter([], null, null, opts);
	}

	/**
	 * Return an array of {@link PText} representing plain text
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PText[]}
	 */
	filterText(opts) {
		return this._filter([], PText._selector, (r, parent, node) => {
			r.push(new PText(parent.pdoc, parent, node));
		}, opts);
	}

	/**
	 * Return an array of {@link PWikiLink} representing wiki links
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PWikiLink[]}
	 */
	filterWikiLinks(opts) {
		return this._filter([], PWikiLink._selector, (r, parent, node) => {
			r.push(new PWikiLink(parent.pdoc, parent, node));
		}, opts);
	}

	/**
	 * Internal list of PNodes in this list.
	 * @prop {PNode[]}
	 * @private
	 */
	get pnodes() {
		if (this._cachedPNodes !== null) {
			return this._cachedPNodes;
		}
		const templates = new Set();
		const result = [];
		/* eslint-disable no-labels */
		OUTER: for (let i = 0; i < this.container.childNodes.length; i++) {
			const node = this.container.childNodes.item(i);
			if (node.nodeType === Node.TEXT_NODE) {
				result.push(new PText(this.pdoc, this, node));
				continue;
			}
			if (node.nodeType === Node.COMMENT_NODE) {
				result.push(new PComment(this.pdoc, this, node));
				continue;
			}
			if (node.nodeType === Node.ELEMENT_NODE) {
				// Note: multiple PTemplates per Node, and possibly
				// multiple Nodes per PTemplate.
				if (node.matches(PTemplate._selector)) {
					templates.add(node.getAttribute('about'));
					this._templatesForNode(node).forEach((t) => {
						result.push(t);
					});
					continue;
				} else if (templates.has(node.getAttribute('about'))) {
					continue;
				}
				// PTag is the catch-all; it should always be last.
				const which = [
					PExtLink, PHeading, PHtmlEntity, PMedia,
					PSection, PWikiLink,
					PTag,
				];
				for (let j = 0; j < which.length; j++) {
					const Ty = which[j];
					if (node.matches(Ty._selector)) {
						result.push(new Ty(this.pdoc, this, node));
						continue OUTER;
					}
				}
			}
			// Unknown type.
			result.push(new PNode(this.pdoc, this, node));
		}
		/* eslint-enable no-labels */
		return (this._cachedPNodes = result);
	}

	/**
	 * The number of nodes within the node list.
	 * @prop {number}
	 */
	get length() { return this.pnodes.length; }

	/**
	 * Return the `index`th node within the node list.
	 * @param {number} index
	 * @return {PNode}
	 */
	get(index) { return this.pnodes[index]; }

	/**
	 * Return the index of `target` in the list of nodes, or `-1` if
	 * the target was not found.
	 *
	 * If `recursive` is true, we will look in all nodes of ours and
	 * their descendants, and return the index of our direct descendant
	 * node which contains the target.  Otherwise, the search is done
	 * only on direct descendants.
	 *
	 * If `fromIndex` is provided, it is the index to start the search
	 * at.
	 * @param {PNode|Node} target
	 * @param {Object} [options]
	 * @param {boolean} [options.recursive=false]
	 * @param {number} [options.fromIndex=0]
	 */
	indexOf(target, options) {
		const recursive = Boolean(options && options.recursive);
		const fromIndex = Number(options && options.fromIndex) || 0;
		let child, children;
		let i, j;
		if (target instanceof PNode) {
			target = target.node;
		}
		for (i = fromIndex; i < this.length; i++) {
			child = this.get(i);
			if (child.matches(target)) {
				return i;
			}
			if (recursive) {
				children = child._children();
				for (j = 0; j < children.length; j++) {
					if (children[j].indexOf(target, options) !== -1) {
						return i;
					}
				}
			}
		}
		return -1;
	}

	/**
	 * Return a string representing the contents of this object
	 * as HTML conforming to the
	 * [MediaWiki DOM specification](https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec).
	 * @return {string}
	 */
	toHtml() {
		return this.container.innerHTML;
	}

	/**
	 * Return a promise for a string representing the contents of this
	 * object as wikitext.
	 * @return {Promise}
	 */
	toWikitext() {
		return wts(this.pdoc.env, this.nodes);
	}

	/**
	 * Return a string representing the contents of this object for
	 * debugging.  Some contents may be elided.
	 * @return {string}
	 */
	toString() {
		return toStringHelper(this.nodes);
	}
}
/**
 * Create a {@link PNodeList} from a string containing HTML.
 * @return {PNodeList}
 * @static
 */
PNodeList.fromHTML = function(pdoc, html) {
	const div = pdoc.document.createElement('div');
	div.innerHTML = html;
	return new PNodeList(pdoc, null, div);
};

/**
 * @class PNode
 * A PNode represents a specific DOM {@link Node}.  Its subclasses provide
 * specific accessors and mutators for associated semantic information.
 *
 * Useful subclasses of {@link PNode} include:
 *
 * - {@link PComment}: comments, like `<!-- example -->`
 * - {@link PExtLink}: external links, like `[http://example.com Example]`
 * - {@link PHeading}: headings, like `== Section 1 ==`
 * - {@link PHtmlEntity}: html entities, like `&nbsp;`
 * - {@link PMedia}: images and media, like `[[File:Foo.jpg|caption]]`
 * - {@link PSection}: section; wraps a PHeading and its contents
 * - {@link PTag}: other HTML tags, like `<span>`
 * - {@link PTemplate}: templates, like `{{foo|bar}}`
 * - {@link PText}: unformatted text, like `foo`
 * - {@link PWikiLink}: wiki links, like `[[Foo|bar]]`
 * @constructor
 * @private
 * @param {PDoc} pdoc The parent document for this PNode.
 * @param {PNodeList|null} parent A containing node list which will receive
 *    updates when this {@link PNode} is mutated.
 * @param {Node} node The DOM node.
 * @param {Object} [opts]
 * @param {Function} [opts.update]
 *   A function which will be invoked when {@link #update} is called.
 * @param {Function} [opts.wtsNodes]
 *   A function returning an array of {@link Node}s which can tweak the
 *   portion of the document serialized by {@link #toWikitext}.
 */
class PNode {
	constructor(pdoc, parent, node, opts) {
		/** @prop {PDoc} pdoc The parent document for this {@link PNode}. */
		this.pdoc = pdoc;
		this.parent = parent;
		/** @prop {Node} node The underlying DOM {@link Node}. */
		this.node = node;
		this._update = (opts && opts.update);
		this._wtsNodes = (opts && opts.wtsNodes);
	}

	get ownerDocument() { return this.node.ownerDocument; }

	get dataMw() {
		return DU.getJSONAttribute(this.node, 'data-mw', {});
	}
	set dataMw(v) {
		DU.setJSONAttribute(this.node, 'data-mw', v);
		this.update();
	}

	/**
	 * Internal helper: enumerate all PNodeLists contained within this node.
	 * @private
	 * @return {PNodeList[]}
	 */
	_children() { return []; }

	/**
	 * Call {@link #update} after manually mutating the DOM {@link Node}
	 * associated with this {@link PNode} in order to ensure that any
	 * containing templates are refreshed with their updated contents.
	 *
	 * The mutation methods in the API automatically call {@link #update}
	 * for you when required.
	 */
	update() {
		if (this._update) { this._update(); }
		if (this.parent) { this.parent.update(); }
	}

	/**
	 * Returns true if the `target` matches this node.  By default a
	 * node matches only if its #node is strictly equal to the target
	 * or the target's #node.  Subclasses can override this to provide
	 * more flexible matching: for example see {@link PText#matches}.
	 * @param {Node|PNode} target
	 * @return {boolean} true if the target matches this node, false otherwise.
	 */
	matches(target) {
		return (target === this) || (target === this.node) ||
			(target instanceof PNode && target.node === this.node);
	}

	/**
	 * @inheritdoc PNodeList#toHtml
	 */
	toHtml() {
		const nodes = this._wtsNodes ? this._wtsNodes() : [ this.node ];
		return nodes.map(function(n) { return n.outerHTML; }).join('');
	}

	/**
	 * @inheritdoc PNodeList#toWikitext
	 */
	toWikitext() {
		const nodes = this._wtsNodes ? this._wtsNodes() : [ this.node ];
		return wts(this.pdoc.env, nodes);
	}

	/**
	 * @inheritdoc PNodeList#toString
	 */
	toString() {
		const nodes = this._wtsNodes ? this._wtsNodes() : [ this.node ];
		return toStringHelper(nodes);
	}
}

// Helper: getter and setter for the inner contents of a node.
const innerAccessorGet = function(self) {
	return new PNodeList(self.pdoc, self, self.node);
};
const innerAccessorSet = function(self, v) {
	self.node.innerHTML = toHtmlStr(self.node, v);
	self.update();
};

/**
 * PTag represents any otherwise-unmatched tag.  This includes
 * HTML-style tags in wikicode, like `<span>`, as well as some
 * "invisible" tags like `<p>`.
 * @class PTag
 * @extends PNode
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 */
class PTag extends PNode {

	/**
	 * The name of the tag, in lowercase.
	 */
	get tagName() { return this.node.tagName.toLowerCase(); }

	/**
	 * The contents of the tag, as a {@PNodeList} object.
	 * You can assign a String, Node, or PNodeList to mutate the contents.
	 * @prop {PNodeList}
	 */
	get contents() { return innerAccessorGet(this); }
	set contents(v) { innerAccessorSet(this, v); }

	_children() { return [this.contents]; }
}
/**
 * @ignore
 * @static
 * @private
 */
PTag._selector = '*'; // any otherwise-unmatched element

/**
 * PComment represents a hidden HTML comment, like `<!-- fobar -->`.
 * @class PComment
 * @extends PNode
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 */
class PComment extends PNode {

	/**
	 * The hidden text contained between `<!--` and `-->`.
	 * @prop {string}
	 */
	get contents() {
		return DU.decodeComment(this.node.data);
	}
	set contents(v) {
		this.node.data = DU.encodeComment(v);
		this.update();
	}
}
/**
 * @ignore
 * @static
 * @private
 */
PComment._selector = 'COMMENT'; // non-standard selector

/**
 * PExtLink represents an external link, like `[http://example.com Example]`.
 * @class PExtLink
 * @extends PNode
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 */
class PExtLink extends PNode {

	/**
	 * The name of the tag, in lowercase.
	 */
	get tagName() { return this.node.tagName.toLowerCase(); }

	/**
	 * The URL of the link target.
	 * @prop {string}
	 */
	get url() {
		// XXX url should be a PNodeList, but that requires handling
		// typeof="mw:ExpandedAttrs"
		return this.node.getAttribute('href');
	}
	set url(v) {
		this.node.setAttribute('href', v);
	}

	/**
	 * The link title, as a {@link PNodeList}.
	 * You can assign a String, Node, or PNodeList to mutate the title.
	 * @prop {PNodeList}
	 */
	get title() { return innerAccessorGet(this); }
	set title(v) { innerAccessorSet(this, v); }

	// XXX include this.url, once it is a PNodeList
	_children() { return [this.title]; }
}

/**
 * @ignore
 * @static
 * @private
 */
PExtLink._selector = 'a[rel="mw:ExtLink"]';

/**
 * PHeading represents a section heading in wikitext, like `== Foo ==`.
 * @class PHeading
 * @extends PNode
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 */
class PHeading extends PNode {

	/**
	 * The name of the tag, in lowercase.
	 */
	get tagName() { return this.node.tagName.toLowerCase(); }

	/**
	 * The heading level, as an integer between 1 and 6 inclusive.
	 * @prop {number}
	 */
	get level() {
		return +this.node.nodeName.slice(1);
	}
	set level(v) {
		v = +v;
		if (v === this.level) {
			return;
		} else if (v >= 1 && v <= 6) {
			const nh = this.ownerDocument.createElement('h' + v);
			while (this.node.firstChild !== null) {
				nh.appendChild(this.node.firstChild);
			}
			this.node.parentNode.replaceChild(nh, this.node);
			this.node = nh;
			this.update();
		} else {
			throw new Error("Level must be between 1 and 6, inclusive.");
		}
	}

	/**
	 * The title of the heading, as a {@link PNodeList}.
	 * You can assign a String, Node, or PNodeList to mutate the title.
	 * @prop {PNodeList}
	 */
	get title() { return innerAccessorGet(this); }
	set title(v) { innerAccessorSet(this, v); }

	_children() { return [this.title]; }
}
/**
 * @ignore
 * @static
 * @private
 */
PHeading._selector = 'h1,h2,h3,h4,h5,h6';

/**
 * PHtmlEntity represents an HTML entity, like `&nbsp;`.
 * @class PHtmlEntity
 * @extends PNode
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 */
class PHtmlEntity extends PNode {

	/**
	 * The character represented by the HTML entity.
	 * @prop {string}
	 */
	get normalized() { return this.node.textContent; }
	set normalized(v) {
		this.node.textContent = v;
		this.node.removeAttribute('data-parsoid');
		this.update();
	}

	/**
	 * Extends {@link PNode#matches} to allow a target string to match
	 * if it matches this node's #normalized character.
	 * @inheritdoc PNode#matches
	 * @param {Node|PNode|string} target
	 */
	matches(target) {
		return super.matches(target) || this.normalized === target;
	}
}
/**
 * @ignore
 * @static
 * @private
 */
PHtmlEntity._selector = '[typeof="mw:Entity"]';

/**
 * PMedia represents an image or audio/video element in wikitext,
 * like `[[File:Foobar.jpg|caption]]`.
 * @class PMedia
 * @extends PNode
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 */
class PMedia extends PNode {

	/**
	 * The name of the tag, in lowercase.
	 */
	get tagName() { return this.node.tagName.toLowerCase(); }

	// Internal helper: is the outer element a <figure> or a <span>?
	get _isBlock() { return this.node.tagName === 'FIGURE'; }
	// Internal helper: get at the 'caption' property in the dataMw
	get _caption() {
		const c = this.dataMw.caption;
		return c === undefined ? null : c;
	}
	set _caption(v) {
		const dmw = this.dataMw;
		if (v === undefined || v === null) {
			delete dmw.caption;
		} else {
			dmw.caption = v;
		}
		this.dataMw = dmw;
	}

	/**
	 * The caption of the image or media file, or `null` if not present.
	 * You can assign `null`, a String, Node, or PNodeList to mutate the
	 * contents.
	 * @prop {PNodeList|null}
	 */
	get caption() {
		let c, captionDiv;
		// Note that _cachedNodeList is null if caption is missing.
		if (this._cachedNodeList === undefined) {
			if (this._isBlock) {
				c = this.node.firstChild.nextSibling;
				this._cachedNodeList =
					c ? new PNodeList(this.pdoc, this, c) : null;
			} else {
				c = this._caption;
				if (c === null) {
					this._cachedNodeList = null;
				} else {
					captionDiv = this.ownerDocument.createElement('div');
					captionDiv.innerHTML = c;
					this._cachedNodeList = new PNodeList(
						this.pdoc, this, captionDiv, {
							update: function() {
								this.parent._caption = this.container.innerHTML;
							},
						});
				}
			}
		}
		return this._cachedNodeList;
	}
	set caption(v) {
		this._cachedNodeList = undefined;
		if (this._isBlock) {
			let c = this.node.firstChild.nextSibling;
			if (v === null || v === undefined) {
				if (c) {
					this.node.removeChild(c);
					this.update();
				}
			} else {
				if (!c) {
					c = this.ownerDocument.createElement('figcaption');
					this.node.appendChild(c);
				}
				c.innerHTML = toHtmlStr(c, v);
				this.update();
			}
		} else {
			this._caption = (v === null || v === undefined) ? v :
				toHtmlStr(this.node, v);
			this.update();
		}
	}

	_children() {
		const c = this.caption;
		return c ? [ c ] : [];
	}
}
/**
 * @ignore
 * @static
 * @private
 */
PMedia._selector = 'figure,[typeof~="mw:Image"]';

/**
 * PSection represents an internal wikilink, like `[[Foo|Bar]]`.
 * @class PSection
 * @extends PTag
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 */
class PSection extends PTag {

	/**
	 * The section id. 0 is the lead section, negative numbers are used for
	 * "pseudo-sections".
	 * @prop {number}
	 */
	get sectionId() {
		return +this.node.getAttribute('data-mw-section-id');
	}
}
/**
 * @ignore
 * @static
 * @private
 */
PSection._selector = 'section';

/**
 * PTemplate represents a wikitext template, like `{{foo}}`.
 * @class PTemplate
 * @extends PNode
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 * @param {PDoc} pdoc The parent document for this PNode.
 * @param {PNodeList|null} parent A containing node list which will receive
 *    updates when this {@link PNode} is mutated.
 * @param {Node} node The DOM node.
 * @param {number} which A single {@link Node} can represent multiple
 *   templates; this parameter serves to distinguish them.
 */
class PTemplate extends PNode {
	constructor(pdoc, parent, node, which) {
		super(pdoc, parent, node, {
			wtsNodes: function() {
				// Templates are actually a collection of nodes.
				return this.parent._querySelectorAll('[about="' + this.node.getAttribute('about') + '"]');
			},
		});
		this.which = which;
		this._cachedParams = Object.create(null);
	}

	get _template() {
		return this.dataMw.parts[this.which];
	}
	set _template(v) {
		const dmw = this.dataMw;
		dmw.parts[this.which] = v;
		this.dataMw = dmw;
	}

	/**
	 * The name of the template, as a String.
	 *
	 * See: [T107194](https://phabricator.wikimedia.org/T107194)
	 * @prop {string}
	 */
	get name() {
		// This should really be a PNodeList; see T107194
		return this._template.template.target.wt;
	}
	set name(v) {
		const t = this._template;
		t.template.target.wt = v;
		t.template.target.href = './' +
			this.pdoc.env.normalizedTitleKey('Template:' + v);
		this._template = t;
	}

	/**
	 * Test whether the name of this template matches a given string, after
	 * normalizing titles.
	 * @param {string} name The template name to test against.
	 * @return {boolean}
	 */
	nameMatches(name) {
		const href = './' + this.pdoc.env.normalizedTitleKey('Template:' + name);
		return this._template.template.target.href === href;
	}

	/**
	 * The parameters supplied to this template.
	 * @prop {PTemplate.Parameter[]}
	 */
	get params() {
		return Object.keys(this._template.template.params).sort().map((k) => {
			return this.get(k);
		});
	}

	/**
	 * Return `true` if any parameter in the template is named `name`.
	 * With `ignoreEmpty`, `false` will be returned even if the template
	 * contains a parameter named `name`, if the parameter's value is empty
	 * (ie, only contains whitespace).  Note that a template may have
	 * multiple parameters with the same name, but only the last one is
	 * read by Parsoid (and the MediaWiki parser).
	 * @param {string|PTemplate.Parameter} name
	 * @param {Object} [opts]
	 * @param {boolean} [opts.ignoreEmpty=false]
	 */
	has(name, opts) {
		if (name instanceof PTemplate.Parameter) {
			name = name.name;
		}
		const t = this._template.template;
		return Object.prototype.hasOwnProperty.call(t.params, name) && (
			(opts && opts.ignoreEmpty) ?
				!/^\s*$/.test(t.params[name].html) : true
		);
	}

	/**
	 * Add a parameter to the template with a given `name` and `value`.
	 * If `name` is already a parameter in the template, we'll replace
	 * its value.
	 * @param {string|PTemplate.Parameter} name
	 * @param {string|Node|PNodeList} value
	 */
	add(name, value) {
		if (name instanceof PTemplate.Parameter) {
			name = name.name;
		}
		const t = this._template;
		const html = toHtmlStr(this.node, value);
		t.template.params[name] = { html: html };
		this._template = t;
	}

	/**
	 * Remove a parameter from the template with the given `name`.
	 * If `keepField` is `true`, we will keep the parameter's name but
	 * blank its value.  Otherwise we will remove the parameter completely
	 * *unless* other parameters are dependent on it (e.g. removing
	 * `bar` from `{{foo|bar|baz}}` is unsafe because `{{foo|baz}}` is
	 * not what we expected, so `{{foo||baz}}` will be produced instead).
	 * @param {string|PTemplate.Parameter} name
	 * @param {Object} [opts]
	 * @param {boolean} [opts.keepField=false]
	 */
	remove(name, opts) {
		if (name instanceof PTemplate.Parameter) {
			name = name.name;
		}
		const t = this._template;
		let keepField = opts && opts.keepField;
		// if this is a numbered template, force keepField if there
		// are subsequent numbered templates.
		const isNumeric = (String(+name) === String(name));
		if (isNumeric && this.has(1 + (+name))) {
			keepField = true;
		}
		if (keepField) {
			t.template.params[name] = { html: '' };
		} else {
			delete t.template.params[name];
		}
		this._template = t;
	}

	/**
	 * Get the parameter whose name is `name`.
	 * @param {string|PTemplate.Parameter} name
	 * @return {PTemplate.Parameter} The parameter record.
	 */
	get(name) {
		if (name instanceof PTemplate.Parameter) {
			name = name.name;
		}
		if (!this._cachedParams[name]) {
			this._cachedParams[name] = new PTemplate.Parameter(this, name);
		}
		return this._cachedParams[name];
	}

	_children() {
		const result = [];
		this.params.forEach((k) => {
			const p = this.get(k);
			if (p.key) { result.push(p.key); }
			result.push(p.value);
		});
		return result;
	}
}
/**
 * @ignore
 * @static
 * @private
 */
PTemplate._selector = '[typeof~="mw:Transclusion"]';

/**
 * @class PTemplate.Parameter
 *
 * Represents a parameter of a template.
 *
 * For example, the template `{{foo|bar|spam=eggs}}` contains two
 * {@link PTemplate.Parameter}s: one whose #name is `"1"` and whose
 * whose #value is a {@link PNodeList} corresponding to `"bar"`, and one
 * whose #name is `"spam"` and whose #value is a {@link PNodeList}
 * corresponding to `"eggs"`.
 *
 * See: {@link PTemplate}
 * @constructor
 * @private
 * @param {PTemplate} parent The parent template for this parameter.
 * @param {string} k The parameter name.
 */
PTemplate.Parameter = class Parameter {
	constructor(parent, k) {
		const doc = parent.ownerDocument;
		const param = parent._template.template.params[k];
		const valDiv = doc.createElement('div');
		valDiv.innerHTML = param.html;
		this._name = k;
		this._value = new PNodeList(parent.pdoc, parent, valDiv, {
			update: function() {
				const t = this.parent._template;
				delete t.template.params[k].wt;
				t.template.params[k].html = this.container.innerHTML;
				this.parent._template = t;
			},
		});
		const keyDiv = doc.createElement('div');
		this._key = new PNodeList(parent.pdoc, parent, keyDiv, {
			update: function() {
				const t = this.parent._template;
				if (this._hasKey) {
					if (!t.template.params[k].key) {
						t.template.params[k].key = {};
					}
					delete t.template.params[k].key.wt;
					t.template.params[k].key.html = this.container.innerHTML;
				} else {
					delete t.template.params[k].key;
				}
				this.parent._template = t;
			},
		});
		if (param.key && param.key.html) {
			// T106852 means this doesn't always work.
			keyDiv.innerHTML = param.key.html;
			this._key._hasKey = true;
		}
	}

	/**
	 * @prop {string} name
	 *   The expanded parameter name.
	 *   Unnamed parameters are given numeric indexes.
	 * @readonly
	 */
	get name() { return this._name; }

	/**
	 * @prop {PNodeList|null} key
	 *   Source nodes corresponding to the parameter name.
	 *   For example, in `{{echo|{{echo|1}}=hello}}` the parameter name
	 *   is `"1"`, but the `key` field would contain the `{{echo|1}}`
	 *   template invocation, as a {@link PNodeList}.
	 */
	get key() { return this._key._hasKey ? this._key : null; }
	set	key(v) {
		if (v === null || v === undefined) {
			this._key.container.innerHTML = '';
			this._key._hasKey = false;
		} else {
			this._key.container.innerHTML =
				toHtmlStr(this._key.container, v);
		}
		this._key.update();
	}

	/**
	 * @prop {PNodeList} value
	 *    The parameter value.
	 */
	get value() { return this._value; }
	set value(v) {
		this._value.container.innerHTML =
			toHtmlStr(this._value.container, v);
		this._value.update();
	}

	toString() {
		const k = this.key;
		return (k ? String(k) : this.name) + '=' + String(this.value);
	}
};
PTemplate.Parameter.prototype.toWikitext = Promise.async(function *() {
	const k = this.key;
	const keyWikitext = k ? (yield k.toWikitext()) : this.name;
	const valueWikitext = yield this.value.toWikitext();
	return `${keyWikitext}=${valueWikitext}`;
});

/**
 * PText represents ordinary unformatted text with no special properties.
 * @class PText
 * @extends PNode
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 */
class PText extends PNode {

	/**
	 * The actual text itself.
	 * @prop {string}
	 */
	get value() {
		return this.node.data;
	}
	set value(v) {
		this.node.data = v;
		this.update();
	}

	/**
	 * Extends {@link PNode#matches} to allow a target string to match
	 * if it matches this node's #value.
	 * @inheritdoc PNode#matches
	 * @param {Node|PNode|string} target
	 */
	matches(target) {
		return super.matches(target) || this.value === target;
	}
}
/**
 * @ignore
 * @static
 * @private
 */
PText._selector = 'TEXT'; // non-standard selector

/**
 * PWikiLink represents an internal wikilink, like `[[Foo|Bar]]`.
 * @class PWikiLink
 * @extends PNode
 * @constructor
 * @private
 * @inheritdoc PNode#constructor
 */
class PWikiLink extends PNode {

	/**
	 * The name of the tag, in lowercase.
	 */
	get tagName() { return this.node.tagName.toLowerCase(); }

	/**
	 * The title of the linked page.
	 * @prop {string}
	 */
	get title() {
		// XXX url should be a PNodeList, but that requires handling
		// typeof="mw:ExpandedAttrs"
		return this.node.getAttribute('href').replace(/^.\//, '');
	}
	set title(v) {
		const href = './' + this.pdoc.env.normalizedTitleKey(v);
		this.node.setAttribute('href', href);
		this.update();
	}

	/**
	 * The text to display, as a {@link PNodeList}.
	 * You can assign a String, Node, or PNodeList to mutate the text.
	 * @prop {PNodeList}
	 */
	get text() { return innerAccessorGet(this); }
	set text(v) { innerAccessorSet(this, v); }

	_children() { return [this.text]; }
}
/**
 * @ignore
 * @static
 * @private
 */
PWikiLink._selector = 'a[rel="mw:WikiLink"]';

/**
 * A PDoc object wraps an entire Parsoid document.  Since it is an
 * instance of {@link PNodeList}, you can filter it, mutate it, etc.
 * But it also provides means to serialize the document as either
 * HTML (via {@link #document} or {@link #toHtml}) or wikitext
 * (via {@link #toWikitext}).
 * @class
 * @extends PNodeList
 */
class PDoc extends PNodeList {
	constructor(env, doc) {
		super(null, null, doc.body);
		this.pdoc = this;
		this.env = env;
	}

	/**
	 * An HTML {@link Document} representing article content conforming to the
	 * [MediaWiki DOM specification](https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec).
	 * @prop {Document}
	 */
	get document() { return this.container.ownerDocument; }
	set document(v) { this.container = v.body; }

	/**
	 * Return a string representing the entire document as
	 * HTML conforming to the
	 * [MediaWiki DOM specification](https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec).
	 * @inheritdoc PNodeList#toHtml
	 */
	toHtml() {
		// document.outerHTML is a Parsoid-ism; real browsers don't define it.
		let html = this.document.outerHTML;
		if (!html) {
			html = this.document.body.outerHTML;
		}
		return html;
	}
}

// Promise-using REPL, for easier debugging.
// We also handle `yield`, at least in common cases.
const repl = function() {
	const Parsoid = require('./');
	console.log('Parsoid REPL', Parsoid.version);
	const r = require('repl').start({ ignoreUndefined: true });
	// `let Parsoid = require('parsoid');` by default.
	r.context.Parsoid = Parsoid;
	// `let Promise = require('prfun');` by default.
	r.context.Promise = Promise;
	// Patch the `eval` method to wait for Promises to be resolved.
	const oldEval = r.eval;
	r.eval = function(cmd, context, filename, callback) {
		// If `cmd` mentions `yield`, wrap it in a `function*`
		if (/\byield\b/.test(cmd)) {
			// Hack to support `var xyz = yield pdq...;`, convert it
			// to `var xyz; ...{ xyz = yield pdq...; }...`
			var m = /^((?:var|let)\s+)(\w+)\s*=/.exec(cmd);
			if (m) { cmd = cmd.slice(m[1].length); }
			cmd = 'Promise.async(function*(){' + cmd + '})();';
			if (m) { cmd = m[1] + m[2] + ';' + cmd; }
		}
		oldEval.call(r, cmd, context, filename, function(e, v) {
			if (e || !(typeof v === 'object' && typeof v.then === 'function')) {
				return callback(e, v);
			}
			// OK, this is a promise!  Wait for the result.
			v.then(function(_v) {
				callback(null, _v);
			}, function(_e) {
				callback(_e);
			});
		});
	};
};

module.exports = {
	PDoc,
	PNodeList,
	PNode,
	PComment,
	PExtLink,
	PHeading,
	PHtmlEntity,
	PMedia,
	PSection,
	PTag,
	PTemplate,
	PText,
	PWikiLink,
	// Helper function for `Promise.map`
	toWikitext: Promise.async(function *(n) { return (yield n.toWikitext()); }),
	// Useful REPL that handles promises and `yield` well.
	repl,
};
