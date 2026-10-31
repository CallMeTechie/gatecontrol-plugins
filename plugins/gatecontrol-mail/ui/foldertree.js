/* Mail (gatecontrol-mail) — the folders of an account as a tree in the portal's menu (since 1.3.4):
 * window.MailFolderTree in the page, module.exports in the tests (test/portal-folders.test.js). No DOM here.
 *
 *   build    GET folders → the tree: the folders with a role on top (Posteingang, Entwürfe, Gesendet, Archiv, Spam,
 *            Papierkorb, as before), then the others by name; children below their parent (parentId), by name. A parent
 *            the answer does not hold (it was not synced) leaves its children on top, so does a loop.
 *   rows     what the menu shows: the children of a closed folder are hidden; a closed parent counts the unread mail
 *            of everything below it
 *   folds    folder id → open (true) / closed (false) as the person chose it this session; without a choice a folder
 *            is closed unless the folder shown lies below it
 */
(function (root) {
  'use strict';

  var ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];
  /** From this depth on the rows are not indented any further. */
  var MAX_INDENT = 4;

  function nameOf(f) { return String((f && f.name) || ''); }
  function rank(f) { var i = f.role ? ROLE_ORDER.indexOf(f.role) : -1; return i >= 0 ? i : ROLE_ORDER.length; }
  function byName(a, b) {
    return rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b), 'de', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  /**
   * The tree of an account's folders → { nodes, byId }: nodes in the menu's order, each { folder, id, depth, parent
   * (the id it hangs below, else null), kids (ids), unreadBelow (all unread below it) }. o.liftInbox: the inbox's
   * children on top (the portal's account row stands for the inbox).
   */
  function build(list, o) {
    var opts = o || {};
    var all = (Array.isArray(list) ? list : []).filter(function (f) { return f && f.id != null; });
    var ids = {};
    all.forEach(function (f) { ids[f.id] = f; });
    var parentOf = function (f) {
      // the folders with a role always on top, as before
      if (f.role) return null;
      var p = f.parentId != null ? ids[f.parentId] : null;
      if (!p || p.id === f.id) return null;
      if (opts.liftInbox && p.role === 'inbox') return null;
      return p.id;
    };
    var kids = { top: [] };
    all.forEach(function (f) {
      var p = parentOf(f);
      var k = p == null ? 'top' : 'f' + p;
      (kids[k] = kids[k] || []).push(f);
    });
    var nodes = [];
    var byId = {};
    var walk = function (f, depth, parent) {
      if (byId[f.id]) return null;
      var n = { folder: f, id: f.id, depth: depth, parent: parent, kids: [], unreadBelow: 0 };
      byId[f.id] = n;
      nodes.push(n);
      (kids['f' + f.id] || []).slice().sort(byName).forEach(function (c) {
        var cn = walk(c, depth + 1, f.id);
        if (cn) { n.kids.push(c.id); n.unreadBelow += (Number(c.unread) || 0) + cn.unreadBelow; }
      });
      return n;
    };
    kids.top.slice().sort(byName).forEach(function (f) { walk(f, 0, null); });
    // a loop of parents (a → b → a) reaches no top: such folders go on top
    all.slice().sort(byName).forEach(function (f) { if (!byId[f.id]) walk(f, 0, null); });
    return { nodes: nodes, byId: byId };
  }

  /** The ids above folder `id` in the tree (its parent first). */
  function ancestors(tree, id) {
    var out = [];
    var n = tree.byId[id];
    while (n && n.parent != null && out.indexOf(n.parent) < 0) { out.push(n.parent); n = tree.byId[n.parent]; }
    return out;
  }

  /** Whether folder `id` is open: as chosen this session (folds), else when the folder shown (`current`) lies below it. */
  function isOpen(tree, folds, id, current) {
    if (folds && Object.prototype.hasOwnProperty.call(folds, id)) return !!folds[id];
    return current != null && ancestors(tree, current).indexOf(id) >= 0;
  }

  /** folds after a tap on the arrow of folder `id` (it opens or closes; nothing else changes). */
  function toggle(tree, folds, id, current) {
    var out = {};
    Object.keys(folds || {}).forEach(function (k) { out[k] = folds[k]; });
    out[id] = !isOpen(tree, folds, id, current);
    return out;
  }

  /** folds with every folder above `id` open (a folder picked or pointed at is never hidden). */
  function reveal(tree, folds, id) {
    var out = {};
    Object.keys(folds || {}).forEach(function (k) { out[k] = folds[k]; });
    ancestors(tree, id).forEach(function (a) { out[a] = true; });
    return out;
  }

  /**
   * The rows the menu shows → [{ folder, id, depth, indent (depth up to MAX_INDENT), hasKids, open, unreadBelow (only
   * for a closed parent, else 0) }]: the children of a closed folder are left out.
   */
  function rows(tree, folds, current) {
    var out = [];
    var hiddenBelow = null;
    tree.nodes.forEach(function (n) {
      if (hiddenBelow != null) {
        if (n.depth > hiddenBelow) return;
        hiddenBelow = null;
      }
      var has = n.kids.length > 0;
      var open = has && isOpen(tree, folds, n.id, current);
      out.push({ folder: n.folder, id: n.id, depth: n.depth, indent: Math.min(n.depth, MAX_INDENT), hasKids: has, open: open, unreadBelow: has && !open ? n.unreadBelow : 0 });
      if (has && !open) hiddenBelow = n.depth;
    });
    return out;
  }

  var api = { ROLE_ORDER: ROLE_ORDER, MAX_INDENT: MAX_INDENT, build: build, ancestors: ancestors, isOpen: isOpen, toggle: toggle, reveal: reveal, rows: rows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MailFolderTree = api;
})(typeof window !== 'undefined' ? window : this);
