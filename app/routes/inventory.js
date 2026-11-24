'use strict';
const express = require('express');
const db = require('../db');
const inv = require('../inventory');
const counts = require('../invcount');
const access = require('../permissions');
const activity = require('../activity');
const { requireLogin, requirePerm, forbidden, flash } = require('../auth');
const { clean } = require('../util');

const router = express.Router();
const manage = requirePerm('inventory.manage');
const maySee = (user) => access.can(user, 'parts.view') || access.can(user, 'inventory.manage') || access.can(user, 'stock.manage');
// A location of the office being looked at, or nothing: another office's is never opened or changed.
const mine = (req) => { const l = inv.location(req.params.id); return l && l.branch_id === req.user.workBranch ? l : null; };
const personOf = (req, id) => (/^\d+$/.test(String(id || ''))
  ? db.prepare('SELECT id, display_name FROM users WHERE id = ? AND branch_id = ? AND active = 1 AND removed_at IS NULL').get(id, req.user.workBranch) : null);

router.get('/admin/inventory', requireLogin, (req, res) => {
  if (!maySee(req.user)) return forbidden(res);
  const office = db.prepare('SELECT id, name FROM branches WHERE id = ?').get(req.user.workBranch);
  res.render('admin_inventory', {
    title: 'Inventory', office, kinds: inv.KINDS, locations: inv.locations(req.user.workBranch, { withRetired: true }),
    free: inv.withoutVehicle(req.user.workBranch), mayManage: access.can(req.user, 'inventory.manage'),
  });
});

router.get('/admin/inventory/locations/:id', requireLogin, (req, res) => {
  if (!maySee(req.user)) return forbidden(res);
  const place = mine(req);
  if (!place) return res.status(404).render('error', { title: 'Not found', message: 'That location is not in this branch.' });
  const mayManage = access.can(req.user, 'inventory.manage');
  res.render('admin_inventory_location', {
    title: place.name, place, kinds: inv.KINDS, rows: inv.contents(place.id), mayManage, dollars: inv.dollars, history: inv.history(place.id), stats: inv.stats(place.id),
    showCost: mayManage || access.can(req.user, 'catalog.manage'),
    technician: place.user_id ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(place.user_id) : null,
    free: place.kind === 'vehicle' ? inv.withoutVehicle(req.user.workBranch) : [],
  });
});

router.post('/admin/inventory/locations', manage, (req, res) => {
  const name = clean(req.body.name, 60);
  const kind = req.body.kind === 'vehicle' ? 'vehicle' : 'custom';
  if (!name) { flash(req, 'err', 'Give the location a name.'); return res.redirect('/admin/inventory'); }
  if (db.prepare('SELECT 1 FROM inv_locations WHERE branch_id = ? AND active = 1 AND name = ? COLLATE NOCASE').get(req.user.workBranch, name)) {
    flash(req, 'err', `This branch already has a location called ${name}.`); return res.redirect('/admin/inventory');
  }
  if (kind === 'vehicle') {
    const person = personOf(req, req.body.user_id);
    if (!person) { flash(req, 'err', 'Choose whose vehicle it is.'); return res.redirect('/admin/inventory'); }
    if (db.prepare("SELECT 1 FROM inv_locations WHERE kind = 'vehicle' AND active = 1 AND user_id = ?").get(person.id)) {
      flash(req, 'err', `${person.display_name} already has a vehicle.`); return res.redirect('/admin/inventory');
    }
    inv.addVehicle(req.user.workBranch, name, person.id);
    activity.log(req.user, 'Inventory location added', `${name} (vehicle, ${person.display_name})`);
  } else {
    inv.addCustom(req.user.workBranch, name);
    activity.log(req.user, 'Inventory location added', name);
  }
  flash(req, 'ok', `${name} added.`);
  res.redirect('/admin/inventory');
});

// Move parts by hand: from one of the office's locations to another, or a delivery straight into one.
router.post('/admin/inventory/moves', manage, (req, res) => {
  const back = '/admin/inventory';
  const own = (id) => { const l = inv.location(id); return l && l.branch_id === req.user.workBranch && l.active ? l : null; };
  const to = own(req.body.to); const from = req.body.from === 'delivery' ? null : own(req.body.from);
  const qty = /^\d{1,5}$/.test(String(req.body.quantity || '').trim()) ? Number(req.body.quantity) : 0;
  const typed = clean(req.body.part_number, 100);
  let part = db.prepare('SELECT id, part_number FROM parts_catalog WHERE part_number = ?').get(typed);
  const fail = (msg) => { flash(req, 'err', msg); res.redirect(back); };
  if (!to || (req.body.from !== 'delivery' && !from)) return fail('Choose where the parts are coming from and going to.');
  if (from && from.id === to.id) return fail('Choose two different places.');
  if (!typed) return fail('Enter the part.');
  if (qty < 1) return fail('Enter how many, as a whole number.');
  if (!part) part = customPart(typed, req.user);          // typed by hand: it joins the catalog so it can be kept track of
  const note = clean(req.body.note, 200) || null;
  const stockLib = require('../stock'); const before = stockLib.levels(req.user.workBranch);
  inv.move({ branchId: req.user.workBranch, catalogId: part.id, from: from && from.id, to: to.id, quantity: qty, kind: from ? 'transfer' : 'receive', note, userId: req.user.id });
  stockLib.tellLow(req.user, req.user.workBranch, before);   // moving parts out of the warehouse can take one to its minimum
  activity.log(req.user, from ? 'Parts moved' : 'Delivery received', `${qty} × ${part.part_number}: ${from ? from.name + ' to ' : 'into '}${to.name}`);
  flash(req, 'ok', `${qty} × ${part.part_number} ${from ? 'moved to' : 'received into'} ${to.name}.`);
  res.redirect(back);
});

// Rename a location, or hand a vehicle to someone else. What is in it stays in it.
router.post('/admin/inventory/locations/:id', manage, (req, res) => {
  const place = mine(req);
  if (!place) return forbidden(res);
  const back = `/admin/inventory/locations/${place.id}`;
  const name = clean(req.body.name, 60);
  if (!name) { flash(req, 'err', 'Give the location a name.'); return res.redirect(back); }
  if (db.prepare('SELECT 1 FROM inv_locations WHERE branch_id = ? AND active = 1 AND id <> ? AND name = ? COLLATE NOCASE').get(place.branch_id, place.id, name)) {
    flash(req, 'err', `This branch already has a location called ${name}.`); return res.redirect(back);
  }
  let userId = place.user_id;
  if (place.kind === 'vehicle' && req.body.user_id !== undefined && String(req.body.user_id) !== String(place.user_id)) {
    const person = personOf(req, req.body.user_id);
    if (!person) { flash(req, 'err', 'Choose whose vehicle it is.'); return res.redirect(back); }
    if (db.prepare("SELECT 1 FROM inv_locations WHERE kind = 'vehicle' AND active = 1 AND user_id = ? AND id <> ?").get(person.id, place.id)) {
      flash(req, 'err', `${person.display_name} already has a vehicle.`); return res.redirect(back);
    }
    userId = person.id;
    activity.log(req.user, 'Vehicle handed over', `${name}: now ${person.display_name}`);
  }
  if (name !== place.name) activity.log(req.user, 'Inventory location renamed', `${place.name} is now ${name}`);
  db.prepare('UPDATE inv_locations SET name = ?, user_id = ? WHERE id = ?').run(name, userId, place.id);
  flash(req, 'ok', 'Saved.');
  res.redirect(back);
});

// A location that is no longer used is put away, not deleted: its history stays. It has to be empty first.
router.post('/admin/inventory/locations/:id/:op', manage, (req, res) => {
  const place = mine(req);
  if (!place || !['retire', 'restore'].includes(req.params.op)) return forbidden(res);
  if (req.params.op === 'retire') {
    if (place.kind === 'warehouse') { flash(req, 'err', 'The main warehouse cannot be put away.'); return res.redirect('/admin/inventory'); }
    if (inv.contents(place.id).length) { flash(req, 'err', `${place.name} still holds parts. Move them out first.`); return res.redirect(`/admin/inventory/locations/${place.id}`); }
    db.prepare('UPDATE inv_locations SET active = 0 WHERE id = ?').run(place.id);
    activity.log(req.user, 'Inventory location put away', place.name);
    flash(req, 'ok', `${place.name} was put away.`);
  } else {
    if (place.kind === 'vehicle' && place.user_id && db.prepare("SELECT 1 FROM inv_locations WHERE kind = 'vehicle' AND active = 1 AND user_id = ?").get(place.user_id)) {
      flash(req, 'err', 'That person has another vehicle now.'); return res.redirect('/admin/inventory');
    }
    db.prepare('UPDATE inv_locations SET active = 1 WHERE id = ?').run(place.id);
    activity.log(req.user, 'Inventory location brought back', place.name);
    flash(req, 'ok', `${place.name} is in use again.`);
  }
  res.redirect('/admin/inventory');
});

// ---- Exports: what the office holds right now, as a spreadsheet ----
const { sendCsv } = require('../csv');
const exporter = requirePerm('inventory.export');
const money = (cents) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));
const today = () => require('../util').localDate();
const slug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'office';
const BY_PLACE = ['Branch', 'Location', 'Kind', 'Technician', 'Part number', 'Description', 'On hand', 'Cost each', 'Value'];
const placeRow = (r) => [r.office, r.location, inv.KINDS[r.kind], r.technician || '', r.part_number, r.description, r.on_hand, money(r.cost_cents), r.cost_cents === null ? '' : money(r.cost_cents * r.on_hand)];

// One office (the one being looked at), or every office for someone who sees them all.
router.get('/admin/inventory/export.csv', exporter, (req, res) => {
  const every = req.query.office === 'all' && req.user.allBranches;
  const rows = inv.holdings({ branchId: every ? null : req.user.workBranch });
  const office = every ? 'all-branches' : slug((db.prepare('SELECT name FROM branches WHERE id = ?').get(req.user.workBranch) || {}).name);
  if (req.query.view !== 'totals') return sendCsv(res, `inventory-${office}-by-location-${today()}.csv`, BY_PLACE, rows.map(placeRow));
  // Totals: one line per part per office, with how it splits between the warehouse, the vehicles and anywhere else.
  const parts = new Map();
  for (const r of rows) {
    const key = `${r.office}\u0000${r.part_number}`;
    const t = parts.get(key) || { office: r.office, part_number: r.part_number, description: r.description, cost_cents: r.cost_cents, warehouse: 0, vehicle: 0, custom: 0 };
    t[r.kind] += r.on_hand; parts.set(key, t);
  }
  sendCsv(res, `inventory-${office}-totals-${today()}.csv`, ['Branch', 'Part number', 'Description', 'On hand in all', 'Main warehouse', 'Vehicles', 'Other locations', 'Cost each', 'Value'],
    [...parts.values()].map((t) => { const all = t.warehouse + t.vehicle + t.custom; return [t.office, t.part_number, t.description, all, t.warehouse, t.vehicle, t.custom, money(t.cost_cents), t.cost_cents === null ? '' : money(t.cost_cents * all)]; }));
});

// One location by itself: the warehouse, or a single vehicle.
router.get('/admin/inventory/locations/:id/export.csv', exporter, (req, res) => {
  const place = mine(req);
  if (!place) return forbidden(res);
  sendCsv(res, `inventory-${slug(place.name)}-${today()}.csv`, BY_PLACE, inv.holdings({ branchId: place.branch_id, locationId: place.id }).map(placeRow));
});

// ---- The inventory count ----
const mayApprove = (user) => access.can(user, 'inventory.approve');
const mayCountAll = (user) => access.can(user, 'inventory.count') || mayApprove(user);
// A count of the office being looked at; or, for someone counting their own vehicle, of their own office.
const auditOf = (req) => { const a = counts.get(req.params.id); return a && (a.branch_id === req.user.workBranch || a.branch_id === req.user.branch_id) ? a : null; };
const mayCount = (user, audit, place) => (mayCountAll(user) && audit.branch_id === user.workBranch) || (place.kind === 'vehicle' && place.user_id === user.id);
const thisMonth = () => require('../util').localDate().slice(0, 7);

router.get('/admin/inventory/count', requireLogin, (req, res) => {
  if (!maySee(req.user) && !mayCountAll(req.user)) return forbidden(res);
  const current = counts.open(req.user.workBranch);
  if (current) return res.redirect(`/admin/inventory/count/${current.id}`);
  res.render('admin_inventory_count', { title: 'Inventory count', past: counts.past(req.user.workBranch), monthName: counts.monthName, month: thisMonth(), mayApprove: mayApprove(req.user) });
});

router.post('/admin/inventory/count', requirePerm('inventory.approve'), (req, res) => {
  const made = counts.start(req.user.workBranch, clean(req.body.month, 7), req.user.id);
  if (typeof made === 'string') { flash(req, 'err', made); return res.redirect('/admin/inventory/count'); }
  activity.log(req.user, 'Inventory count started', counts.monthName(req.body.month));
  res.redirect(`/admin/inventory/count/${made}`);
});

// A closed count's figures, as they stood when it was closed.
router.get('/admin/inventory/count/:id/export.csv', exporter, (req, res) => {
  const audit = auditOf(req);
  if (!audit || audit.branch_id !== req.user.workBranch || audit.status !== 'closed') return forbidden(res);
  const office = (db.prepare('SELECT name FROM branches WHERE id = ?').get(audit.branch_id) || {}).name;
  sendCsv(res, `inventory-${slug(office)}-count-${audit.month}.csv`, ['Branch', 'Location', 'Kind', 'Part number', 'Description', 'On hand', 'Cost each', 'Value'],
    counts.closedFigures(audit.id).map((r) => [office, r.location, inv.KINDS[r.kind], r.part_number, r.description, r.quantity, money(r.cost_cents), r.cost_cents === null ? '' : money(r.cost_cents * r.quantity)]));
});

router.get('/admin/inventory/count/:id', requireLogin, (req, res) => {
  const audit = auditOf(req);
  if (!audit || audit.branch_id !== req.user.workBranch || (!maySee(req.user) && !mayCountAll(req.user))) return forbidden(res);
  const showCost = mayApprove(req.user) || access.can(req.user, 'inventory.manage') || access.can(req.user, 'catalog.manage');
  if (audit.status === 'closed') {
    return res.render('admin_inventory_closed', { title: `Inventory, ${counts.monthName(audit.month)}`, audit, rows: counts.closedFigures(audit.id), monthName: counts.monthName, dollars: inv.dollars, showCost,
      closedBy: audit.closed_by ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(audit.closed_by) : null });
  }
  res.render('admin_inventory_count_one', { title: `Count for ${counts.monthName(audit.month)}`, audit, ...counts.progress(audit), monthName: counts.monthName, dollars: inv.dollars, showCost,
    mayApprove: mayApprove(req.user), mayCount: mayCountAll(req.user), proved: require('./auth').provedRecently(req) });
});

// These two come before the count sheet's address, which would otherwise take "close" for a location.
router.post('/admin/inventory/count/:id/close', requirePerm('inventory.approve'), (req, res) => {
  const audit = auditOf(req);
  if (!audit || audit.branch_id !== req.user.workBranch) return forbidden(res);
  if (audit.status !== 'open') return res.redirect(`/admin/inventory/count/${audit.id}`);
  if (!require('./auth').provedRecently(req)) { flash(req, 'err', 'Type your password to close the count.'); return res.redirect(`/admin/inventory/count/${audit.id}#close`); }
  const done = counts.close(audit, req.user.id);
  activity.log(req.user, 'Inventory count closed', `${counts.monthName(audit.month)}: ${done.lines} counted, ${done.changed} corrected`);
  flash(req, 'ok', `${counts.monthName(audit.month)} is closed. ${done.changed} ${done.changed === 1 ? 'figure was' : 'figures were'} corrected to match the count.`);
  res.redirect(`/admin/inventory/count/${audit.id}`);
});

router.post('/admin/inventory/count/:id/discard', requirePerm('inventory.approve'), (req, res) => {
  const audit = auditOf(req);
  if (!audit || audit.branch_id !== req.user.workBranch || audit.status !== 'open') return forbidden(res);
  counts.discard(audit);
  activity.log(req.user, 'Inventory count set aside', counts.monthName(audit.month));
  flash(req, 'ok', 'The count was set aside. Nothing was changed.');
  res.redirect('/admin/inventory/count');
});

/** A part typed by hand that the catalog does not have: added to it (with no description or cost yet) so it can be counted and moved. */
function customPart(number, user) {
  const id = db.prepare("INSERT INTO parts_catalog (part_number, description, created_at) VALUES (?, '', ?)").run(number, new Date().toISOString()).lastInsertRowid;
  activity.log(user, 'Catalog part added', `${number}, typed by hand`);
  return db.prepare('SELECT id, part_number FROM parts_catalog WHERE id = ?').get(id);
}

function sheetPage(req, res, extra = {}) {
  const audit = auditOf(req); const place = audit ? inv.location(req.params.loc) : null;
  if (!audit || !place || place.branch_id !== audit.branch_id || !mayCount(req.user, audit, place)) { forbidden(res); return null; }
  if (audit.status !== 'open') { res.redirect(mayCountAll(req.user) ? `/admin/inventory/count/${audit.id}` : '/'); return null; }
  if (extra.justLoad) return { audit, place };
  res.status(extra.errors ? 400 : 200).render('inventory_count_sheet', { title: `Count: ${place.name}`, audit, place, rows: counts.sheet(audit, place), monthName: counts.monthName,
    backToCount: mayCountAll(req.user) && audit.branch_id === req.user.workBranch, errors: [], added: '', finished: counts.finishedAt(audit, place), ...extra });
  return null;
}
router.get('/admin/inventory/count/:id/:loc', requireLogin, (req, res) => { sheetPage(req, res); });

router.post('/admin/inventory/count/:id/:loc', requireLogin, (req, res) => {
  const found = sheetPage(req, res, { justLoad: true });
  if (!found) return;
  const { audit, place } = found; const errors = []; let saved = 0;
  const number = (v) => (/^\d{1,6}$/.test(String(v).trim()) ? Number(String(v).trim()) : null);
  db.transaction(() => {
    for (const [field, raw] of Object.entries(req.body)) {
      const m = /^qty_(\d+)$/.exec(field); if (!m) continue;
      const part = db.prepare('SELECT id, part_number FROM parts_catalog WHERE id = ?').get(m[1]); if (!part) continue;
      if (String(raw).trim() === '') { counts.count(audit, place, part.id, null); continue; }
      const n = number(raw);
      if (n === null) { errors.push(`${part.part_number}: enter a whole number, or leave it empty if it has not been counted.`); continue; }
      counts.count(audit, place, part.id, n, req.user.id); saved += 1;
    }
    const added = clean(req.body.add_part, 100);
    if (added) {
      let part = db.prepare('SELECT id FROM parts_catalog WHERE part_number = ?').get(added); const n = number(req.body.add_qty ?? '');
      if (n === null) errors.push(`Enter how many of ${added} there are.`);
      else { if (!part) part = customPart(added, req.user); counts.count(audit, place, part.id, n, req.user.id); saved += 1; }
    }
  })();
  if (errors.length) return sheetPage(req, res, { errors, added: errors.some((e) => /how many of/.test(e)) ? clean(req.body.add_part, 100) : '' });
  // Saving keeps what has been counted so far and nothing more. A location is finished only when someone says so.
  if (req.body.finish === '1') {
    counts.finish(audit, place, req.user.id);
    flash(req, 'ok', `${place.name} is marked as finished. ${saved} ${saved === 1 ? 'part' : 'parts'} counted.`);
    return res.redirect(mayCountAll(req.user) && audit.branch_id === req.user.workBranch ? `/admin/inventory/count/${audit.id}` : '/');
  }
  if (req.body.finish === 'reopen') { counts.reopen(audit, place); flash(req, 'ok', `${place.name} is open again.`); }
  else flash(req, 'ok', `Saved. ${saved} ${saved === 1 ? 'part' : 'parts'} counted so far in ${place.name}. Come back any time to carry on.`);
  res.redirect(`/admin/inventory/count/${audit.id}/${place.id}`);
});

module.exports = router;
