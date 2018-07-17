/** Testing the JavaScript API. */
/* global describe, it*/

"use strict";

require('chai').should();

const Parsoid = require('../index.js');
const Promise = require('parsoid/lib/utils/promise.js');

describe('Parsoid JS API', function() {
	it('converts empty wikitext to HTML', Promise.async(function *() {
		const res = yield Parsoid.parse('', {
			document: true,
			envOptions: { wrapSections: false },
		});
		res.should.have.property('doc');
		res.doc.should.have.property('outerHTML');
		console.log(res.doc.body.outerHTML);
		res.doc.body.children.length.should.equal(0);
	}));
	it('converts simple wikitext to HTML', Promise.async(function *() {
		const res = yield Parsoid.parse('hi there', { document: true });
		res.should.have.property('doc');
		res.doc.should.have.property('outerHTML');
	}));
});

describe('Examples from guides/jsapi', function() {
	it('converts empty wikitext to HTML', Promise.async(function *() {
		const pdoc = yield Parsoid.parse('', {
			pdoc: true,
			envOptions: { wrapSections: false },
		});
		pdoc.should.have.property('document');
		pdoc.document.should.have.property('outerHTML');
		pdoc.document.body.children.length.should.equal(0);
	}));
	it('converts simple wikitext to HTML', Promise.async(function *() {
		const pdoc = yield Parsoid.parse('I love wikitext!', { pdoc: true });
		pdoc.should.have.property('document');
		pdoc.document.should.have.property('outerHTML');
	}));
	it('filters out templates', Promise.async(function *() {
		const text = "I has a template!\n{{foo|bar|baz|eggs=spam}}\nSee it?\n";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		let wt = yield pdoc.toWikitext();
		wt.should.equal(text);
		const templates = pdoc.filterTemplates();
		templates.length.should.equal(1);
		wt = yield templates[0].toWikitext();
		wt.should.equal('{{foo|bar|baz|eggs=spam}}');
		const template = templates[0];
		template.name.should.equal('foo');
		template.name = 'notfoo';
		wt = yield template.toWikitext();
		wt.should.equal('{{notfoo|bar|baz|eggs=spam}}');
		template.params.length.should.equal(3);
		template.params[0].name.should.equal('1');
		template.params[1].name.should.equal('2');
		template.params[2].name.should.equal('eggs');
		wt = yield template.get(1).value.toWikitext();
		wt.should.equal('bar');
		wt = yield template.get('eggs').value.toWikitext();
		wt.should.equal('spam');
	}));
	it('filters templates, recursively', Promise.async(function *() {
		const text = "{{foo|{{bar}}={{baz|{{spam}}}}}}";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const templates = pdoc.filterTemplates();
		// XXX note that {{bar}} as template name doesn't get handled;
		//     that's bug T106852
		templates.length.should.equal(3);
	}));
	it('filters templates, non-recursively', Promise.async(function *() {
		const text = "{{foo|this {{includes a|template}}}}";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const templates = pdoc.filterTemplates({ recursive: false });
		templates.length.should.equal(1);
		const foo = templates[0];
		let wt = yield foo.get(1).value.toWikitext();
		wt.should.equal('this {{includes a|template}}');
		const more = foo.get(1).value.filterTemplates();
		more.length.should.equal(1);
		wt = yield more[0].get(1).value.toWikitext();
		wt.should.equal('template');
	}));
	it('is easy to mutate templates', Promise.async(function *() {
		const text = "{{cleanup}} '''Foo''' is a [[bar]]. {{uncategorized}}";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		for (const template of pdoc.filterTemplates()) {
			if (template.nameMatches('Cleanup') && !template.has('date')) {
				template.add('date', 'July 2012');
			}
			if (template.nameMatches('uncategorized')) {
				template.name = 'bar-stub';
			}
		}
		const wt = yield pdoc.toWikitext();
		wt.should.equal("{{cleanup|date=July 2012}} '''Foo''' is a [[bar]]. {{bar-stub}}");
	}));
});

describe('Further examples of PDoc API', function() {
	it('is easy to mutate templates (2)', Promise.async(function *() {
		// Works even on nested templates!
		const text = "{{1x|{{cleanup}} '''Foo''' is a [[bar]].}} {{uncategorized}}";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		for (const template of pdoc.filterTemplates()) {
			if (template.nameMatches('Cleanup') && !template.has('date')) {
				template.add('date', 'July 2012');
				// Works even when there are special characters
				template.add('test1', '{{foo}}&bar|bat<p>');
				template.add('test2', Parsoid.PNodeList.fromHTML(pdoc, "I'm so <b>bold</b>!"));
			}
		}
		const wt = yield pdoc.toWikitext();
		wt.should.equal("{{1x|{{cleanup|date=July 2012|test1=<nowiki>{{foo}}</nowiki>&bar{{!}}bat<nowiki><p></nowiki>|test2=I'm so '''bold'''!}} '''Foo''' is a [[bar]].}} {{uncategorized}}");
	}));
	it('is safe to mutate template arguments', Promise.async(function *() {
		const text = "{{1x|foo|bar}}";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const t = pdoc.filterTemplates()[0];
		t.remove(1);
		const wt = yield pdoc.toWikitext();
		wt.should.equal('{{1x||bar}}');
	}));
	it('is safe to mutate template arguments (2)', Promise.async(function *() {
		const text = "{{1x|foo|bar}}";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const t = pdoc.filterTemplates()[0];
		const param1 = t.get(1);
		const param2 = t.get(2);
		param2.value = param1.value;
		param1.value = '|';
		const wt = yield pdoc.toWikitext();
		wt.should.equal('{{1x|{{!}}|foo}}');
	}));
	it('filters and mutates headings', Promise.async(function *() {
		const text = "= one =\n== two ==\n=== three ===\n==== four ====\nbody";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const headings = pdoc.filterHeadings();
		headings.length.should.equal(4);
		headings[0].level.should.equal(1);
		headings[1].level.should.equal(2);
		headings[2].level.should.equal(3);
		headings[3].level.should.equal(4);
		headings[0].title.toHtml().should.equal('one');
		headings[1].title.toHtml().should.equal('two');
		headings[2].title.toHtml().should.equal('three');
		headings[3].title.toHtml().should.equal('four');
		headings[0].title = '=0=';
		headings[1].title = headings[2].title;
		headings[3].level = 3;
		const wt = yield pdoc.toWikitext();
		wt.should.equal('=<nowiki>=0=</nowiki>=\n==three==\n===three===\n\n=== four ===\nbody');
	}));
	it('filters and mutates headings inside templates', Promise.async(function *() {
		const text = "{{1x|1=\n= one =\n}}";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const headings = pdoc.filterHeadings();
		headings.length.should.equal(1);
		headings[0].level = 2;
		let wt = yield headings[0].toWikitext();
		wt.should.equal('== one ==\n');
		wt = yield pdoc.toWikitext();
		wt.should.equal('{{1x|1=\n== one ==\n}}');
		headings[0].title = 'two';
		wt = yield headings[0].toWikitext();
		wt.should.equal('== two ==\n');
		wt = yield pdoc.toWikitext();
		wt.should.equal('{{1x|1=\n== two ==\n}}');
	}));
	it('filters and mutates external links', Promise.async(function *() {
		const text = "[http://example.com {{1x|link content}}]";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const extlinks = pdoc.filterExtLinks();
		extlinks.length.should.equal(1);
		String(extlinks[0].url).should.equal('http://example.com');
		let wt = yield extlinks[0].title.toWikitext();
		wt.should.equal('{{1x|link content}}');
		extlinks[0].title = ']';
		wt = yield pdoc.toWikitext();
		wt.should.equal('[http://example.com <nowiki>]</nowiki>]');
	}));
	it('filters and mutates wiki links', Promise.async(function *() {
		const text = "[[foo|1]] {{1x|[[bar|2]]}} [[{{1x|bat}}|3]]";
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const extlinks = pdoc.filterWikiLinks();
		extlinks.length.should.equal(3);
		extlinks[0].title.toString().should.equal('Foo');
		(yield extlinks[0].text.toWikitext()).should.equal('1');
		extlinks[1].title.toString().should.equal('Bar');
		(yield extlinks[1].text.toWikitext()).should.equal('2');
		(yield extlinks[2].text.toWikitext()).should.equal('3');
		extlinks[0].title = extlinks[0].text = 'foobar';
		extlinks[1].text = 'A';
		extlinks[2].text = 'B';
		const wt = yield pdoc.toWikitext();
		wt.should.equal('[[foobar]] {{1x|[[bar|A]]}} [[{{1x|bat}}|B]]');
	}));
	it('filters and mutates html entities',Promise.async(function *() {
		const text = '&amp;{{1x|&quot;}}';
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const entities = pdoc.filterHtmlEntities();
		entities.length.should.equal(2);
		entities[0].normalized.should.equal('&');
		entities[1].normalized.should.equal('"');
		entities[0].normalized = '<';
		entities[1].normalized = '>';
		const wt = yield pdoc.toWikitext();
		wt.should.equal('&#x3C;{{1x|&#x3E;}}');
	}));
	it('filters and mutates comments', Promise.async(function *() {
		const text = '<!-- foo --> {{1x|<!--bar-->}}';
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const comments = pdoc.filterComments();
		comments.length.should.equal(2);
		comments[0].contents.should.equal(' foo ');
		comments[1].contents.should.equal('bar');
		comments[0].contents = '<!-- ha! -->';
		comments[1].contents = '--';
		const wt = yield pdoc.toWikitext();
		wt.should.equal('<!--<!-- ha! --&gt;--> {{1x|<!------>}}');
	}));
	it('filters and mutates images', Promise.async(function *() {
		var text = '[[File:SomeFile1.jpg]] [[File:SomeFile2.jpg|thumb|caption]]';
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const media = pdoc.filterMedia();
		media.length.should.equal(2);
		media[0].should.have.property('caption', null);
		let wt = yield media[1].caption.toWikitext();
		wt.should.equal('caption');
		media[0].caption = '|';
		media[1].caption = null;
		wt = yield pdoc.toWikitext();
		wt.should.equal('[[File:SomeFile1.jpg|<nowiki>|</nowiki>]] [[File:SomeFile2.jpg|thumb]]');
		media[0].caption = null;
		media[1].caption = '|';
		wt = yield pdoc.toWikitext();
		wt.should.equal('[[File:SomeFile1.jpg]] [[File:SomeFile2.jpg|thumb|<nowiki>|</nowiki>]]');
	}));
	it('filters and mutates text', Promise.async(function *() {
		const text = 'foo {{1x|bar}}';
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		let texts = pdoc.filterText({ recursive: false });
		texts.length.should.equal(1);
		texts = pdoc.filterText({ recursive: true });
		texts.length.should.equal(2);
		texts[0].value.should.equal('foo ');
		texts[1].value.should.equal('bar');
		texts[0].value = 'FOO ';
		let wt = yield pdoc.toWikitext();
		wt.should.equal('FOO {{1x|bar}}');
		texts[1].value = 'BAR';
		wt = yield pdoc.toWikitext();
		wt.should.equal('FOO {{1x|BAR}}');
	}));
	it.skip('filters and mutates text (2)', Promise.async(function *() {
		const text = '{{{1x|{{!}}}}\n| foo\n|}';
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const texts = pdoc.filterText();
		texts.length.should.equal(1);
		// XXX this doesn't work yet, see note at end of
		// https://www.mediawiki.org/wiki/Specs/HTML/1.2.1#Transclusion_content
		// for details. ("Editing support for the interspersed wikitext...")
		texts[0].value.should.equal(' foo');
	}));
	it('allows mutation using wikitext', Promise.async(function *() {
		const text = '== heading ==';
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		const headings = pdoc.filterHeadings();
		headings.length.should.equal(1);
		// Note that even if the wikitext is unbalanced, the result
		// will be balanced.  The bold face doesn't escape the heading!
		const pnl = yield Parsoid.PNodeList.fromWikitext(pdoc, "'''bold");
		headings[0].title = pnl;
		const wt = yield pdoc.toWikitext();
		wt.should.equal("== '''bold''' ==\n");
	}));
	it('allows iteration using length and get()', Promise.async(function *() {
		const text = '== 1 ==\n[http://example.com 2]<!-- 3 -->&nbsp;{{1x|4}} 5 [[Foo|6]]';
		const pdoc = yield Parsoid.parse(text, { pdoc: true });
		pdoc.length.should.equal(3);
		pdoc.get(0).should.be.instanceof(Parsoid.PHeading);
		pdoc.get(1).should.be.instanceof(Parsoid.PText);
		pdoc.get(2).should.be.instanceof(Parsoid.PTag);
		pdoc.get(2).tagName.should.be.equal('p');
		const paragraph = pdoc.get(2).contents;
		paragraph.length.should.equal(6);
		paragraph.get(0).should.be.instanceof(Parsoid.PExtLink);
		paragraph.get(1).should.be.instanceof(Parsoid.PComment);
		paragraph.get(2).should.be.instanceof(Parsoid.PHtmlEntity);
		paragraph.get(3).should.be.instanceof(Parsoid.PTemplate);
		paragraph.get(4).should.be.instanceof(Parsoid.PText);
		paragraph.get(5).should.be.instanceof(Parsoid.PWikiLink);
		// Test indexOf with PNodes and Nodes
		for (var i = 0; i < paragraph.length; i++) {
			paragraph.indexOf(paragraph.get(i)).should.equal(i);
			paragraph.indexOf(paragraph.get(i).node).should.equal(i);
			pdoc.indexOf(paragraph.get(i), { recursive: true }).should.equal(2);
			pdoc.indexOf(paragraph.get(i).node, { recursive: true }).should.equal(2);
		}
		// Test indexOf with strings
		pdoc.indexOf(' 5 ').should.equal(-1);
		pdoc.indexOf(' 5 ', { recursive: true }).should.equal(2);
		paragraph.indexOf(' 5 ').should.equal(4);
		paragraph.indexOf('\u00A0').should.equal(2);
	}));
});
