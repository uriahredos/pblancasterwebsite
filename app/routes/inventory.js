'use strict';
const express = require('express');
const db = require('../db');
const inv = require('../inventory');
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
  if (!place) return res.status(404).render('error', { title: 'Not found', message: 'That location is not in this office.' });
  const mayManage = access.can(req.user, 'inventory.manage');
  res.render('admin_inventory_location', {
    title: place.name, place, kinds: inv.KINDS, rows: inv.contents(place.id), mayManage, dollars: inv.dollars,
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
    flash(req, 'err', `This office already has a location called ${name}.`); return res.redirect('/admin/inventory');
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

// Rename a location, or hand a vehicle to someone else. What is in it stays in it.
router.post('/admin/inventory/locations/:id', manage, (req, res) => {
  const place = mine(req);
  if (!place) return forbidden(res);
  const back = `/admin/inventory/locations/${place.id}`;
  const name = clean(req.body.name, 60);
  if (!name) { flash(req, 'err', 'Give the location a name.'); return res.redirect(back); }
  if (db.prepare('SELECT 1 FROM inv_locations WHERE branch_id = ? AND active = 1 AND id <> ? AND name = ? COLLATE NOCASE').get(place.branch_id, place.id, name)) {
    flash(req, 'err', `This office already has a location called ${name}.`); return res.redirect(back);
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

module.exports = router;
