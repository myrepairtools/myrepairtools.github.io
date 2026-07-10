/*
    myRepairTools — Options page logic (auto-save).

    The storage contract is unchanged from the old page: the `enabled` array is
    built from every `.checkmark` button in DOM order; `.lcd-checkmark` controls
    are read individually by id; `.ql-checkmark` are the 3 link-frame toggles.
    Toggle state lives on the `data-checked` attribute. saveOptions() collects
    exactly the same keys; the only behavioral change is auto-save (no Save
    button, no alert) via scheduleSave().
*/

/* ---------------- toggles (keep the legacy class + data-checked hooks) ---------------- */
function flip(el) {
    if (el.getAttribute('data-checked') === 'checked') {
        el.setAttribute('data-checked', 'unchecked');
        el.className = el.className.replace(/\bchecked\b/, '').trim() + ' unchecked';
    } else {
        el.setAttribute('data-checked', 'checked');
        el.className = el.className.replace(/\bunchecked\b/, '').trim() + ' checked';
    }
}
function toggleBox() { flip(this); scheduleSave(); }
function toggleLinkBox() { flip(this); scheduleSave(); }
function toggleLcdBox() { flip(this); scheduleSave(); afterLcdChange(); }

/* ---------------- save ---------------- */
function saveOptions(done) {
    let checkedBoxes = [];
    let checkboxes = document.getElementsByClassName('checkmark');
    for (let b = 0; b < checkboxes.length; b++) {
        checkedBoxes[b] = checkboxes[b].getAttribute('data-checked') === 'checked' ? 1 : 0;
    }
    const customQuickLinkName1 = document.getElementById('customQuickLinkName1').value;
    const customQuickLinkUrl1 = document.getElementById('customQuickLinkUrl1').value;
    const customQuickLinkName2 = document.getElementById('customQuickLinkName2').value;
    const customQuickLinkUrl2 = document.getElementById('customQuickLinkUrl2').value;
    const customQuickLinkName3 = document.getElementById('customQuickLinkName3').value;
    const customQuickLinkUrl3 = document.getElementById('customQuickLinkUrl3').value;
    const cbtText = document.getElementById('binLabelName').value;
    const lcdIds = { enabled: 'lcdEnabled', iphone: 'lcdIphone', galaxys: 'lcdGalaxys', galaxynote: 'lcdGalaxynote', galaxyz: 'lcdGalaxyz', pixel: 'lcdPixel' };
    let lcd = {};
    for (const k in lcdIds) { lcd[k] = document.getElementById(lcdIds[k]).getAttribute('data-checked') === 'checked'; }
    const ai = { enabled: document.getElementById('aiEnabled').getAttribute('data-checked') === 'checked' };
    const sms = {
        followUp: document.getElementById('smsFollowUp').getAttribute('data-checked') === 'checked',
        sendSms: document.getElementById('smsSendSms').getAttribute('data-checked') === 'checked',
        sendCall: document.getElementById('smsSendCall').getAttribute('data-checked') === 'checked',
        sendEmail: document.getElementById('smsSendEmail').getAttribute('data-checked') === 'checked',
        panel: document.getElementById('smsPanel').getAttribute('data-checked') === 'checked'
    };
    const wn = {
        enabled: document.getElementById('wnEnabled').getAttribute('data-checked') === 'checked',
        promise: document.getElementById('wnPromise').getAttribute('data-checked') === 'checked',
        clock: document.getElementById('wnClock').getAttribute('data-checked') === 'checked',
        minsPer: Number(document.getElementById('wnMinsPer').value) || 45,
        open: document.getElementById('wnOpen').value || '10:00',
        close: document.getElementById('wnClose').value || '19:00'
    };
    const mcprIds = { partsGate: 'mcprPartsGate', sickwGate: 'mcprSickwGate', updateAssignee: 'mcprUpdateAssignee', stockBadges: 'mcprStockBadges', priceOverlay: 'mcprPriceOverlay', kbbReturns: 'mcprKbbReturns', popupBlocker: 'mcprPopupBlocker', clockGuard: 'mcprClockGuard' };
    let mcpr = {};
    for (const k in mcprIds) { mcpr[k] = document.getElementById(mcprIds[k]).getAttribute('data-checked') === 'checked'; }
    mcpr.clockTime = document.getElementById('mcprClockTime').value || '09:40';
    mcpr.priceModel = document.getElementById('mcprPriceModel').value === 'cap' ? 'cap' : 'franchise';
    // ticket-type rules grid (which ticket types each popup runs on)
    const TT_FEATURES = ['followUp', 'promise', 'ready', 'blacklist'];
    const TT_TYPES = ['repair', 'claim', 'sale', 'tradein', 'refurbish'];
    let tt = {};
    TT_FEATURES.forEach((f) => {
        tt[f] = {};
        TT_TYPES.forEach((t) => {
            const el = document.getElementById('tt_' + f + '_' + t);
            tt[f][t] = el ? el.getAttribute('data-checked') === 'checked' : true;
        });
    });
    const customQuickLinkFrame1 = document.getElementById('customQuickLinkFrame1').getAttribute('data-checked') === 'checked';
    const customQuickLinkFrame2 = document.getElementById('customQuickLinkFrame2').getAttribute('data-checked') === 'checked';
    const customQuickLinkFrame3 = document.getElementById('customQuickLinkFrame3').getAttribute('data-checked') === 'checked';
    chrome.storage.sync.set({
        customQuickLinkName1, customQuickLinkUrl1, customQuickLinkFrame1,
        customQuickLinkName2, customQuickLinkUrl2, customQuickLinkFrame2,
        customQuickLinkName3, customQuickLinkUrl3, customQuickLinkFrame3,
        enabled: checkedBoxes,
        cbt: { enabled: true, text: cbtText },
        lcd, ai, wn, mcpr, sms, tt
    }, () => { if (typeof done === 'function') done(); });
}

/* ---------------- auto-save orchestration ---------------- */
let saveTimer = null;
function setStatus(saving) {
    const el = document.getElementById('optStatus');
    if (!el) return;
    el.classList.toggle('saving', !!saving);
    el.querySelector('.txt').textContent = saving ? 'Saving…' : 'All changes saved automatically';
}
function showToast() {
    const t = document.getElementById('optToast');
    if (!t) return;
    t.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.remove('show'), 1500);
}
function commitSave() {
    setStatus(true);
    saveOptions(() => { setStatus(false); showToast(); });
}
// toggles / number / time inputs persist immediately; text inputs debounce.
function scheduleSave(debounceMs) {
    clearTimeout(saveTimer);
    if (debounceMs) { saveTimer = setTimeout(commitSave, debounceMs); }
    else { commitSave(); }
}

/* ---------------- LCD master dims the trigger group ---------------- */
function afterLcdChange() {
    const master = document.getElementById('lcdEnabled');
    const group = document.getElementById('lcdTriggers');
    if (master && group) group.classList.toggle('off', master.getAttribute('data-checked') !== 'checked');
}

/* ---------------- restore ---------------- */
function restoreOptions() {
    chrome.storage.sync.get([
        'customQuickLinkName1', 'customQuickLinkUrl1', 'customQuickLinkFrame1',
        'customQuickLinkName2', 'customQuickLinkUrl2', 'customQuickLinkFrame2',
        'customQuickLinkName3', 'customQuickLinkUrl3', 'customQuickLinkFrame3',
        'enabled', 'cbt', 'lcd', 'ai', 'wn', 'mcpr', 'sms', 'tt'
    ]).then((result) => {
        document.getElementById('customQuickLinkName1').value = result.customQuickLinkName1 || '';
        document.getElementById('customQuickLinkUrl1').value = result.customQuickLinkUrl1 || '';
        document.getElementById('customQuickLinkName2').value = result.customQuickLinkName2 || '';
        document.getElementById('customQuickLinkUrl2').value = result.customQuickLinkUrl2 || '';
        document.getElementById('customQuickLinkName3').value = result.customQuickLinkName3 || '';
        document.getElementById('customQuickLinkUrl3').value = result.customQuickLinkUrl3 || '';
        document.getElementById('binLabelName').value = (result.cbt !== undefined) ? result.cbt.text : 'In Possession';

        const setState = (el, on, cls) => {
            el.setAttribute('data-checked', on ? 'checked' : 'unchecked');
            el.className = cls + ' ' + (on ? 'checked' : 'unchecked');
        };
        ['customQuickLinkFrame1', 'customQuickLinkFrame2', 'customQuickLinkFrame3'].forEach((id) => {
            setState(document.getElementById(id), !!result[id], 'ql-checkmark');
        });
        setState(document.getElementById('aiEnabled'), !result.ai || result.ai.enabled !== false, 'lcd-checkmark');
        const smsCfg = result.sms || {};
        // sendSms defaults ON (falls back to the legacy readyText flag); call + email default OFF.
        setState(document.getElementById('smsFollowUp'), smsCfg.followUp !== false, 'lcd-checkmark');
        setState(document.getElementById('smsSendSms'), smsCfg.sendSms !== undefined ? smsCfg.sendSms : (smsCfg.readyText !== false), 'lcd-checkmark');
        setState(document.getElementById('smsSendCall'), smsCfg.sendCall === true, 'lcd-checkmark');
        setState(document.getElementById('smsSendEmail'), smsCfg.sendEmail === true, 'lcd-checkmark');
        setState(document.getElementById('smsPanel'), smsCfg.panel !== false, 'lcd-checkmark');
        setState(document.getElementById('wnEnabled'), !result.wn || result.wn.enabled !== false, 'lcd-checkmark');
        setState(document.getElementById('wnPromise'), !result.wn || result.wn.promise !== false, 'lcd-checkmark');
        setState(document.getElementById('wnClock'), !result.wn || result.wn.clock !== false, 'lcd-checkmark');
        document.getElementById('wnMinsPer').value = (result.wn && result.wn.minsPer) || 45;
        document.getElementById('wnOpen').value = (result.wn && result.wn.open) || '10:00';
        document.getElementById('wnClose').value = (result.wn && result.wn.close) || '19:00';

        const mcpr = result.mcpr || {};
        const mcprDefaults = { partsGate: true, sickwGate: true, updateAssignee: true, stockBadges: true, priceOverlay: true, kbbReturns: true, popupBlocker: false, clockGuard: false };
        const mcprIds = { partsGate: 'mcprPartsGate', sickwGate: 'mcprSickwGate', updateAssignee: 'mcprUpdateAssignee', stockBadges: 'mcprStockBadges', priceOverlay: 'mcprPriceOverlay', kbbReturns: 'mcprKbbReturns', popupBlocker: 'mcprPopupBlocker', clockGuard: 'mcprClockGuard' };
        for (const k in mcprIds) {
            const on = mcpr[k] === undefined ? mcprDefaults[k] : mcpr[k] !== false;
            setState(document.getElementById(mcprIds[k]), on, 'lcd-checkmark');
        }
        document.getElementById('mcprClockTime').value = mcpr.clockTime || '09:40';
        document.getElementById('mcprPriceModel').value = mcpr.priceModel === 'cap' ? 'cap' : 'franchise';

        const lcdIds = { enabled: 'lcdEnabled', iphone: 'lcdIphone', galaxys: 'lcdGalaxys', galaxynote: 'lcdGalaxynote', galaxyz: 'lcdGalaxyz', pixel: 'lcdPixel' };
        for (const k in lcdIds) {
            setState(document.getElementById(lcdIds[k]), !result.lcd || result.lcd[k] !== false, 'lcd-checkmark');
        }
        afterLcdChange();

        // ticket-type rules grid (defaults: everything on; refurbish off for the
        // customer-communication three; blacklist on everywhere)
        const TT_DEF = {
            followUp: { repair: true, claim: true, sale: true, tradein: true, refurbish: false },
            promise: { repair: true, claim: true, sale: true, tradein: true, refurbish: false },
            ready: { repair: true, claim: true, sale: true, tradein: true, refurbish: false },
            blacklist: { repair: true, claim: true, sale: true, tradein: true, refurbish: false },
        };
        const ttCfg = result.tt || {};
        Object.keys(TT_DEF).forEach((f) => {
            Object.keys(TT_DEF[f]).forEach((t) => {
                const el = document.getElementById('tt_' + f + '_' + t);
                if (!el) return;
                const on = (ttCfg[f] && ttCfg[f][t] !== undefined) ? ttCfg[f][t] !== false : TT_DEF[f][t];
                setState(el, on, 'lcd-checkmark tt-mini');
            });
        });

        let checkboxes = document.getElementsByClassName('checkmark');
        for (let c = 0; c < checkboxes.length; c++) {
            const on = (result.enabled === undefined) ? true : result.enabled[c] !== 0;
            checkboxes[c].setAttribute('data-checked', on ? 'checked' : 'unchecked');
            checkboxes[c].className = 'checkmark ' + (on ? 'checked' : 'unchecked');
        }
    });
}

/* ---------------- wiring ---------------- */
function addButtonListeners() {
    Array.from(document.getElementsByClassName('checkmark')).forEach((b) => b.addEventListener('click', toggleBox));
    Array.from(document.getElementsByClassName('lcd-checkmark')).forEach((b) => b.addEventListener('click', toggleLcdBox));
    ['customQuickLinkFrame1', 'customQuickLinkFrame2', 'customQuickLinkFrame3'].forEach((id) => {
        document.getElementById(id).addEventListener('click', toggleLinkBox);
    });

    // whole-row click toggles the row's switch (bigger hit target)
    document.querySelectorAll('.row, .ql-row').forEach((row) => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('button, input, a')) return;
            const sw = row.querySelector('button.checkmark, button.lcd-checkmark, button.ql-checkmark');
            if (sw) sw.click();
        });
    });

    // text inputs debounce-save; number/time save on change
    document.querySelectorAll('input[type="text"]').forEach((inp) => inp.addEventListener('input', () => scheduleSave(500)));
    ['wnMinsPer', 'wnOpen', 'wnClose', 'mcprClockTime', 'mcprPriceModel'].forEach((id) => {
        document.getElementById(id).addEventListener('change', () => scheduleSave());
    });
}

function wireChrome() {
    // sidebar nav: click scrolls; IntersectionObserver tracks the active section
    const nav = document.getElementById('optNav');
    const links = Array.from(nav.querySelectorAll('a[data-target]'));
    links.forEach((a) => a.addEventListener('click', (e) => {
        e.preventDefault();
        const el = document.getElementById(a.getAttribute('data-target'));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    const byId = {};
    links.forEach((a) => byId[a.getAttribute('data-target')] = a);
    const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
            if (en.isIntersecting) {
                links.forEach((a) => a.classList.remove('active'));
                if (byId[en.target.id]) byId[en.target.id].classList.add('active');
            }
        });
    }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
    document.querySelectorAll('.card').forEach((c) => io.observe(c));
    if (links[0]) links[0].classList.add('active');

    // What's new expand/collapse
    const toggle = document.getElementById('optHistToggle');
    const hist = document.getElementById('optHistory');
    toggle.addEventListener('click', () => {
        const open = hist.classList.toggle('show');
        toggle.textContent = open ? 'Hide history ▴' : 'Full history ▾';
    });
    document.getElementById('optWhatsNewLink').addEventListener('click', () => {
        document.getElementById('optBanner').scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (!hist.classList.contains('show')) toggle.click();
    });

    // version badge
    try {
        const v = chrome.runtime.getManifest().version;
        document.getElementById('optVersion').textContent = 'v' + v;
    } catch (e) { /* ignore */ }
}

restoreOptions();
addButtonListeners();
wireChrome();
