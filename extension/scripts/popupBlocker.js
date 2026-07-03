/*
    Popup Blocker (myRepairTools)

    Runs on: cpr.repairq.io/*

    Auto-dismisses / auto-advances RepairQ's repetitive popups:

      - yellow alert banners (kept when they mention "find my" — those matter)
      - Repair T&C modal → clicks "I Agree" and completes the signature flow
        (the background worker injects a stroke into jSignature, MAIN world)
      - Required Attributes modal → selects "See Notes" and closes
      - claim walkthrough → clicks through the safe informational steps and
        fills the Samsung Genuine Parts form

    ⚠ This tool signs T&C forms and fills claim forms automatically. It ships
    DEFAULT OFF — turn it on deliberately in Options → RepairQ workflow tools
    (storage.sync mcpr.popupBlocker) if that trade-off is right for your
    counter flow. Ported from the MyCPRTools extension.
*/

(function () {
    'use strict';

    function log(msg, ...args) {
        console.log('[MRT-Popup]', msg, ...args);
    }
    function warn(msg, ...args) {
        console.warn('[MRT-Popup]', msg, ...args);
    }

    // ─── Rule 1: Yellow Alert Banners ────────────────────────────
    // Auto-dismiss div.alert.alert-warning UNLESS text contains "find my"

    function handleAlertBanners() {
        document.querySelectorAll('div.alert.alert-warning').forEach(alert => {
            if (alert.dataset.mrtHandled) return;
            alert.dataset.mrtHandled = 'true';

            const text = mcprText(alert);

            if (text.includes('find my')) {
                log('Yellow alert — KEEPING (contains "find my"):', text.slice(0, 80));
                return;
            }

            const closeBtn = alert.querySelector('a.close[data-dismiss="alert"], button.close[data-dismiss="alert"]');
            if (closeBtn) {
                closeBtn.click();
            } else {
                alert.remove();
            }
        });
    }

    // ─── Rule 2: Custom Field Modals (#customFieldEditModal) ─────

    function handleCustomFieldModal() {
        const modal = document.getElementById('customFieldEditModal');
        if (!modal || !mcprIsModalVisible(modal)) return;
        if (modal.dataset.mrtHandled === 'true') return;

        const h3 = modal.querySelector('.modal-header h3');
        if (!h3) return;

        const title = mcprText(h3);

        if (title.includes('repair terms and conditions')) {
            modal.dataset.mrtHandled = 'true';
            // Click "I Agree" — NOT the × close button. Closing with × aborts
            // the ticket save; the signature flow must complete the form.
            const iAgreeBtn = modal.querySelector('a.sign-form[data-save="submit"]');
            if (iAgreeBtn) {
                iAgreeBtn.click();
                log('Repair T&C: "I Agree" clicked — waiting for signature modal');
            } else {
                warn('Repair T&C: "I Agree" button NOT FOUND');
            }

        } else if (title.includes('samsung ub adhesive reminder')) {
            modal.dataset.mrtHandled = 'true';

            const checkbox = modal.querySelector('input[type="checkbox"]');
            if (checkbox && !checkbox.checked) {
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            }

            const submitBtn = modal.querySelector('a.submit-form[data-save="submit"]');
            if (submitBtn) {
                submitBtn.click();
                log('Samsung UB Adhesive: Save & Submit clicked');
            } else {
                warn('Samsung UB Adhesive: Save & Submit button NOT FOUND');
            }

        } else {
            log('customFieldEditModal: unrecognised title, leaving alone:', title);
        }
    }

    // ─── Rule 2a: Required Attributes Modal ─────────────────────
    // Appears when closing a ticket without a resolution selected.
    // Auto-selects "See Notes" and clicks Closed.

    function handleRequiredAttributesModal() {
        const modal = document.querySelector('div.required-attributes-modal');
        if (!modal || !mcprIsModalVisible(modal)) return;
        if (modal.dataset.mrtHandled === 'true') return;
        modal.dataset.mrtHandled = 'true';

        const select = modal.querySelector('select.resolution');
        if (select) {
            // Match "See Notes" by option text (IDs can differ between stores)
            const opt = Array.from(select.options)
                .find(o => o.text.trim().toLowerCase() === 'see notes');
            select.value = opt ? opt.value : '115';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            log('Required Attributes: selected "See Notes" (' + select.value + ')');
        } else {
            warn('Required Attributes: resolution select NOT FOUND');
        }

        const submitBtn = modal.querySelector('a.required-attributes-modal-submit');
        if (submitBtn) {
            submitBtn.click();
        } else {
            warn('Required Attributes: submit button NOT FOUND');
        }
    }

    // ─── Rule 2b: Signature Modal (#modal-signature) ─────────────
    // Appears after clicking "I Agree" on the T&C modal. The background
    // service worker runs executeScript in MAIN world (bypasses CSP) to
    // set jSignature stroke data via jQuery.

    function handleSignatureModal() {
        const modal = document.getElementById('modal-signature');
        if (!modal || !mcprIsModalVisible(modal)) return;
        if (modal.dataset.mrtHandled === 'true') return;
        modal.dataset.mrtHandled = 'true';

        // Draw visually on canvas from the content script so it looks real
        const canvas = modal.querySelector('.jSignature');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.beginPath();
                ctx.moveTo(100, 120);
                ctx.lineTo(300, 120);
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.stroke();
            }
        }

        // Guard against invalidated extension context (extension reloaded
        // while the page was open — a page refresh fixes it).
        if (!chrome?.runtime?.sendMessage) {
            warn('Signature modal: extension context invalidated. Reload the page.');
            return;
        }

        try {
            chrome.runtime.sendMessage({ type: 'mcpr:signature' }, (response) => {
                if (chrome.runtime.lastError) {
                    warn('Signature injection message error:', chrome.runtime.lastError.message);
                } else {
                    log('Background injection response:', response);
                }
                // Click Done Signing regardless — if injection had issues the
                // submit will surface what RepairQ says
                setTimeout(() => {
                    const doneBtn = modal.querySelector('button.signature-submit');
                    if (doneBtn) doneBtn.click();
                    else warn('Done Signing button NOT FOUND');
                }, 150);
            });
        } catch (e) {
            warn('Signature sendMessage threw:', e.message, '— reload the page to restore extension context');
        }
    }

    // ─── Rule 2c: Signature Success Modal (#form-sign-success) ────

    function handleSignatureSuccessModal() {
        const modal = document.getElementById('form-sign-success');
        if (!modal || !mcprIsModalVisible(modal)) return;
        if (modal.dataset.mrtHandled === 'true') return;
        modal.dataset.mrtHandled = 'true';

        const closeBtn = modal.querySelector('button[data-dismiss="modal"]');
        if (closeBtn) closeBtn.click();
        else warn('Signature success: Close button NOT FOUND');
    }

    // ─── Page Unload Guard ──────────────────────────────────────
    let mrtPageUnloading = false;

    // ─── Save Request Tracker ────────────────────────────────────
    // Intercept XHR to detect when RepairQ's validate/save requests are in
    // flight, so the walkthrough never clicks during a save.
    let mrtActiveSaves = 0;

    const MRT_WATCHED_URLS = [
        '/ajax/ticket/validate',
        '/ajax/ticket/save',
    ];

    function installSaveTracker() {
        const _origOpen = XMLHttpRequest.prototype.open;
        const _origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url) {
            this._mrtUrl = url;
            return _origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function () {
            if (MRT_WATCHED_URLS.some(u => (this._mrtUrl || '').includes(u))) {
                mrtActiveSaves++;
                this.addEventListener('loadend', () => {
                    mrtActiveSaves = Math.max(0, mrtActiveSaves - 1);
                });
            }
            return _origSend.apply(this, arguments);
        };
    }

    // Resolves once all tracked requests have finished
    function mrtWaitForSaves() {
        return new Promise(resolve => {
            if (mrtActiveSaves === 0) return resolve();
            const interval = setInterval(() => {
                if (mrtActiveSaves === 0) {
                    clearInterval(interval);
                    resolve();
                }
            }, 50);
            setTimeout(() => {
                clearInterval(interval);
                resolve();
            }, 10000);
        });
    }

    // ─── Rule 3: Claim Walkthrough Auto-Advance ──────────────────
    // A single linear async sequence: the MutationObserver starts it once
    // when the modal appears, then it drives all steps internally.

    const SAFE_AUTO_ADVANCE = [
        'trigger-claim-verify-customer',   // Step 1: Yes (device match)
        'trigger-claim-customer-verified', // Step 2: Continue with Claim (customer info)
        'trigger-claim-device-received',   // Step 3: Continue with Claim (device received)
        'trigger-claim-loaner-device-sp',  // Step 4: Continue with Claim (next steps info)
        'trigger-claim-loaner-device-dr',  // Step 5: Perform Repair
    ];

    let mrtWalkthroughRunning = false;

    async function runClaimWalkthrough() {
        if (mrtWalkthroughRunning) return;
        mrtWalkthroughRunning = true;
        log('Claim walkthrough sequence started');

        try {
            while (!mrtPageUnloading) {
                const modal = document.getElementById('claim-walkthrough-modal');
                if (!modal || !mcprIsModalVisible(modal)) break;

                // Samsung Genuine Parts step needs a special form fill
                const claimBody = modal.querySelector('.claim-body');
                if (claimBody && claimBody.offsetHeight > 0) {
                    const bodyH3 = claimBody.querySelector('h3');
                    if (bodyH3 && mcprText(bodyH3).includes('samsung genuine parts')) {
                        await handleSamsungGenuineParts(modal);
                        break; // Samsung GP navigates away — sequence done
                    }
                }

                const footer = modal.querySelector('div.modal-footer.claim-footer');
                if (!footer) {
                    await mrtWait(100);
                    continue;
                }

                let foundBtn = null;
                for (const triggerClass of SAFE_AUTO_ADVANCE) {
                    const btn = footer.querySelector('a.' + triggerClass);
                    if (btn) {
                        foundBtn = { btn, triggerClass };
                        break;
                    }
                }

                if (!foundBtn) break;   // no whitelisted button — done

                await mrtWaitForSaves();
                if (mrtPageUnloading) break;

                const footerSnapshot = footer.innerHTML;

                log('Clicking:', foundBtn.triggerClass);
                foundBtn.btn.click();

                // Wait for the footer to change (next step), the modal to
                // close (navigating away), or timeout
                const advanced = await mrtWaitForChange(() => {
                    if (mrtPageUnloading) return true;
                    const m = document.getElementById('claim-walkthrough-modal');
                    if (!m || !mcprIsModalVisible(m)) return true;
                    const f = m.querySelector('div.modal-footer.claim-footer');
                    if (!f) return true;
                    return f.innerHTML !== footerSnapshot;
                }, 10000);

                if (!advanced) {
                    log('Timed out waiting for next step — stopping sequence');
                    break;
                }
            }
        } finally {
            mrtWalkthroughRunning = false;
            log('Claim walkthrough sequence ended');
        }
    }

    function mrtWait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function mrtWaitForChange(condition, timeout = 10000) {
        return new Promise(resolve => {
            if (condition()) return resolve(true);
            const interval = setInterval(() => {
                if (condition()) {
                    clearInterval(interval);
                    clearTimeout(timer);
                    resolve(true);
                }
            }, 50);
            const timer = setTimeout(() => {
                clearInterval(interval);
                resolve(false);
            }, timeout);
        });
    }

    function handleClaimWalkthrough() {
        const modal = document.getElementById('claim-walkthrough-modal');
        if (!modal || !mcprIsModalVisible(modal)) return;
        if (mrtWalkthroughRunning) return;
        runClaimWalkthrough();
    }

    // ─── Samsung Genuine Parts Form Fill ─────────────────────────

    const SAMSUNG_FALLBACK_IMEI = '357362193178624';
    const SAMSUNG_SCREEN_REPAIR_CODE = 'F82';

    async function handleSamsungGenuineParts(modal) {
        if (mrtPageUnloading) return;
        if (modal.dataset.mrtGspnHandled === 'true') return;
        modal.dataset.mrtGspnHandled = 'true';

        const imeiInput = modal.querySelector('#gspn_imei');
        if (imeiInput) {
            const existing = (imeiInput.value || '').trim();
            if (!/^\d{15}$/.test(existing)) {
                setInputValue(imeiInput, SAMSUNG_FALLBACK_IMEI);
            }
        } else {
            warn('Samsung GP: #gspn_imei NOT FOUND');
        }

        const defectSelect = modal.querySelector('#gspn_iris_defect');
        if (defectSelect) {
            defectSelect.value = SAMSUNG_SCREEN_REPAIR_CODE;
            defectSelect.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            warn('Samsung GP: #gspn_iris_defect NOT FOUND');
        }

        ['#gspn_repair_description', '#gspn_part0_code', '#gspn_part0_oldpart_serial', '#gspn_part0_serial']
            .forEach(selector => {
                const input = modal.querySelector(selector);
                if (input) {
                    if (!input.value.trim()) setInputValue(input, 'N/A');
                } else {
                    warn('Samsung GP: NOT FOUND:', selector);
                }
            });

        await watchForGspnEnabled(modal);
    }

    function setInputValue(input, value) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        )?.set;
        if (nativeSetter) {
            nativeSetter.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur',   { bubbles: true }));
    }

    function watchForGspnEnabled(modal) {
        return new Promise(resolve => {
            const checkAndClick = () => {
                const btn = modal.querySelector('a.trigger-claim-gspn-save');
                if (!btn) { warn('Samsung GP: trigger-claim-gspn-save not found'); return; }
                if (!btn.hasAttribute('disabled')) {
                    gspnObserver.disconnect();
                    clearTimeout(timer);
                    log('Samsung GP: clicking Continue');
                    btn.click();
                    resolve();
                }
            };

            const gspnObserver = new MutationObserver(checkAndClick);
            const footer = modal.querySelector('.modal-footer');
            if (footer) {
                gspnObserver.observe(footer, { attributes: true, subtree: true, attributeFilter: ['disabled', 'class'] });
            }

            checkAndClick();
            const timer = setTimeout(() => {
                gspnObserver.disconnect();
                resolve();
            }, 30000);
        });
    }

    // ─── Main Observer ───────────────────────────────────────────

    function runAllRules() {
        handleAlertBanners();
        handleCustomFieldModal();
        handleRequiredAttributesModal();
        handleSignatureModal();
        handleSignatureSuccessModal();
        handleClaimWalkthrough();
    }

    mcprSetting('popupBlocker', false).then(function (on) {
        if (!on) return;   // default OFF — this tool auto-signs forms

        window.addEventListener('beforeunload', () => { mrtPageUnloading = true; });
        installSaveTracker();

        log('Popup blocker initializing...');
        runAllRules();

        mcprWatchDOM(runAllRules);

        // Reset handled states when modals hide so they re-trigger on reopen
        new MutationObserver(() => {
            const modalsToReset = [
                { id: 'customFieldEditModal',    key: 'mrtHandled' },
                { id: 'modal-signature',         key: 'mrtHandled' },
                { id: 'form-sign-success',       key: 'mrtHandled' },
                { id: 'claim-walkthrough-modal', key: 'mrtGspnHandled', onHide: () => { mrtWalkthroughRunning = false; } },
            ];
            modalsToReset.forEach(({ id, key, onHide }) => {
                const el = document.getElementById(id);
                if (el && !mcprIsModalVisible(el) && el.dataset[key]) {
                    delete el.dataset[key];
                    if (onHide) onHide();
                }
            });

            const reqModal = document.querySelector('div.required-attributes-modal');
            if (reqModal && !mcprIsModalVisible(reqModal) && reqModal.dataset.mrtHandled) {
                delete reqModal.dataset.mrtHandled;
            }
        }).observe(document.body, {
            attributes: true,
            subtree: true,
            attributeFilter: ['style', 'aria-hidden', 'class'],
        });

        log('Popup blocker ready.');
    });
})();
