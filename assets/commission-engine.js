/*
 * commission-engine.js — CPR Oregon shared commission engine
 * Single source of truth for BOTH the Commission Calculator (payroll) and the
 * employee Commission Dashboard. Import this everywhere; never re-implement the
 * math inline, or payroll and the employee view will drift.
 *
 * Loads as a plain script (window.CommissionEngine) and as a CommonJS module.
 * Ported verbatim from commission-calculator.html's computeCommission, with one
 * intentional upgrade: services are a SKU-driven map (rates: {sku:rate}) instead
 * of three hardcoded keys, so adding a commissionable SKU flows everywhere.
 */
(function (root) {
  'use strict';

  // Per-store commission rule defaults. A store with no override inherits these.
  // Set accyGate to 0 to disable the minimum-attach gate.
  var ruleDefaults = {
    accyGate: 0,        // minimum attach to qualify for ANY accessory % (0 = off)
    accyAttach1: 0.25,  // attach gate for tier 1
    accyPct1: 0.10,     // tier 1 reward
    accyGoalPct: 0.05,  // reward for hitting accessory $ goal
    accyAttach2: 0.50,  // attach gate for tier 2
    accyPct2: 0.05,     // tier 2 reward
    dev1Count: 5,       // devices for the base device tier
    dev1Pct: 0.05,
    devAttachPct: 0.05, // reward for 100% accessory attach on device tickets
    dev2Min: 20,        // 20–24 device band
    dev2Max: 24,
    dev2Pct: 0.05,
    dev3Count: 25,      // 25+ devices
    dev3Pct: 0.10
  };

  // Default flat service payouts ($ per item). Expandable — add a SKU here (and in
  // the calculator's Service payouts settings) and it's picked up automatically.
  var rateDefaults = { cleaning: 10, express: 10, malware: 10 };

  // Friendly labels for known service SKUs (calculator settings can add more).
  var serviceLabels = { cleaning: 'Device cleaning', express: 'Express fee', malware: 'Virus removal' };

  // Merge a store's overrides onto the defaults.
  function rulesFor(rules, store) {
    var o = (rules && rules[store]) || {}, r = {};
    for (var k in ruleDefaults) r[k] = (o[k] != null ? o[k] : ruleDefaults[k]);
    return r;
  }

  // Pull per-service counts off a totals row. Supports either an explicit
  // services map (t.services = {sku:count}) or the legacy fixed fields.
  function serviceCounts(t) {
    if (t.services) return t.services;
    return { cleaning: t.Cleanings || 0, express: t.ExpressRepairs || 0, malware: t.Malware || 0 };
  }

  /*
   * computeCommission(totals, cfg) -> breakdown
   *   totals: { AccyUnits, Tickets, NetAccySales, AccyGP,
   *             DeviceUnits, DeviceReturns, DeviceRev, DeviceGP,
   *             Cleanings, ExpressRepairs, Malware  (or services:{sku:count}) }
   *   cfg:    { accessoryGoal, accDeviceUnits, rates:{sku:rate}, active, rules }
   *     - accDeviceUnits: '' / null / undefined = attach ASSUMED met; a number = actual.
   *     - active:false  = exempt (lead/manager) — earns services only, no accy/device %.
   */
  function computeCommission(t, cfg) {
    cfg = cfg || {};
    var rates = cfg.rates || rateDefaults;
    var R = cfg.rules || ruleDefaults;

    // ----- Accessories -----
    var attach = t.Tickets > 0 ? t.AccyUnits / t.Tickets : 0;
    var netAccy = t.NetAccySales || 0, accyGP = t.AccyGP || 0;
    var gated = (R.accyGate > 0 && attach < R.accyGate);            // hard minimum-attach gate
    var t25 = attach >= R.accyAttach1 ? R.accyPct1 : 0;
    var goal = (cfg.accessoryGoal > 0 && netAccy >= cfg.accessoryGoal) ? R.accyGoalPct : 0;
    var t50 = attach >= R.accyAttach2 ? R.accyPct2 : 0;
    var accyComm = gated ? 0 : (t25 + goal + t50) * accyGP;

    // ----- Devices (net of returns) -----
    var netDev = (t.DeviceUnits || 0) - (t.DeviceReturns || 0);
    var dev5 = netDev >= R.dev1Count ? R.dev1Pct : 0;
    var entered = !(cfg.accDeviceUnits === '' || cfg.accDeviceUnits === null || cfg.accDeviceUnits === undefined);
    var attachMet = entered ? (netDev > 0 && (Number(cfg.accDeviceUnits) / netDev) >= 1) : true;
    var devAttach = attachMet ? R.devAttachPct : 0;
    var dev2024 = (netDev >= R.dev2Min && netDev <= R.dev2Max && devAttach > 0) ? R.dev2Pct : 0;
    var dev25 = (netDev >= R.dev3Count && dev5 > 0) ? R.dev3Pct : 0;
    var devComm = (dev5 + devAttach + dev2024 + dev25) * (t.DeviceGP || 0);

    // ----- Services (SKU-driven) -----
    var counts = serviceCounts(t), svc = {}, repairComm = 0, svcUnits = 0;
    for (var sku in rates) {
      var cnt = Number(counts[sku]) || 0;
      var pay = cnt * rates[sku];
      svc[sku] = { count: cnt, rate: rates[sku], pay: pay };
      repairComm += pay; svcUnits += cnt;
    }

    var exempt = (cfg.active === false);
    return {
      attach: attach, netAccy: netAccy, accyGP: accyGP, assumed: !entered, gated: gated, rules: R,
      netDev: netDev, svcUnits: svcUnits, svc: svc,
      tiers: { t25: t25, goal: goal, t50: t50, dev5: dev5, devAttach: devAttach, dev2024: dev2024, dev25: dev25 },
      accyComm: exempt ? 0 : accyComm,
      devComm: exempt ? 0 : devComm,
      repairComm: repairComm, exempt: exempt,
      total: (exempt ? 0 : accyComm) + (exempt ? 0 : devComm) + repairComm
    };
  }

  // Split one person's commission across the stores they worked: accessory + device
  // by GP share, services charged to the store where performed.
  function splitCharge(byStore, c, rates) {
    byStore = byStore || {}; rates = rates || rateDefaults;
    var stores = Object.keys(byStore);
    if (!stores.length) return [];
    var adComm = c.accyComm + c.devComm, totalGP = 0;
    stores.forEach(function (s) { var b = byStore[s] || {}; totalGP += (+b.AccyGP || 0) + (+b.DeviceGP || 0); });
    return stores.map(function (s) {
      var b = byStore[s] || {};
      var gpShare = totalGP > 0 ? ((+b.AccyGP || 0) + (+b.DeviceGP || 0)) / totalGP : 1 / stores.length;
      var counts = serviceCounts(b), svc = 0;
      for (var sku in rates) svc += (Number(counts[sku]) || 0) * rates[sku];
      return { store: s, amt: adComm * gpShare + svc };
    }).sort(function (a, b) { return b.amt - a.amt; });
  }

  function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(n) { return (Number(n) * 100).toFixed(1) + '%'; }

  var API = {
    ruleDefaults: ruleDefaults,
    rateDefaults: rateDefaults,
    serviceLabels: serviceLabels,
    rulesFor: rulesFor,
    computeCommission: computeCommission,
    splitCharge: splitCharge,
    serviceCounts: serviceCounts,
    money: money,
    pct: pct
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.CommissionEngine = API;
})(typeof window !== 'undefined' ? window : this);
