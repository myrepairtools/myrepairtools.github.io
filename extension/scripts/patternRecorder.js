/*
    Pattern Recorder (myRepairTools)

    Runs on: cpr.repairq.io/ticket/edit/*, /ticket/repair*

    Records a customer's Android unlock pattern. Originally (RQ Mods) a
    sidebar "UNLOCK PATTERN" button that copied ###pattern to the clipboard;
    now a small 3×3-grid icon sitting right next to each device Password
    field. Clicking it opens the pattern pad; saving writes ###<pattern>
    straight into that row's password box (and still copies it to the
    clipboard as backup).

    Toggle: the "Pattern recorder" checkbox in Options (legacy positional
    `enabled[6]`, same as before the rewrite).
*/

(function () {
    'use strict';

    var PASS_SEL = 'input[placeholder^="Password"], input[placeholder^="password"]';
    var pattern = '';
    var drawing = false;
    var targetInput = null;
    var modal = null;

    /* ---------------- per-field icon ---------------- */

    function decorate() {
        document.querySelectorAll(PASS_SEL).forEach(function (input) {
            if (input.dataset.mrtPr) return;
            input.dataset.mrtPr = '1';

            var icon = document.createElement('a');
            icon.className = 'mrt-pr-icon';
            icon.href = '#';
            icon.title = 'Record unlock pattern';
            icon.innerHTML = '<i class="icon-th"></i>';
            icon.style.cssText = 'display:inline-block;min-width:16px;min-height:16px;margin-left:6px;vertical-align:middle;cursor:pointer;font-size:15px;line-height:1;color:#4FB0E3;text-decoration:none;';
            icon.addEventListener('click', function (e) {
                e.preventDefault();
                openPad(input);
            });
            input.insertAdjacentElement('afterend', icon);
        });
    }

    /* ---------------- pattern pad ---------------- */

    function buildModal() {
        if (modal) return;
        modal = document.createElement('div');
        modal.id = 'mrtPatternPad';
        modal.innerHTML =
            '<style>' +
            '#mrtPatternPad{position:fixed;inset:0;z-index:2147483580;display:none;background:rgba(45,45,59,.6);align-items:center;justify-content:center;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}' +
            '#mrtPatternPad.open{display:flex}' +
            '.mrt-pr-card{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);padding:18px 20px;width:330px;text-align:center}' +
            '.mrt-pr-card h4{margin:0 0 4px;font-size:16px;color:#2D2D3B}' +
            '.mrt-pr-card .sub{font-size:11.5px;color:#8A8FA3;margin-bottom:12px}' +
            '.mrt-pr-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:26px;padding:10px 26px 16px;touch-action:none;user-select:none}' +
            '.mrt-pr-dot{width:58px;height:58px;border-radius:50%;border:2.5px solid #B9BDCB;display:flex;align-items:center;justify-content:center;font-size:13px;color:#B9BDCB;cursor:pointer;user-select:none}' +
            '.mrt-pr-dot.on{border-color:#4FB0E3;background:#EAF6FD;color:#1E7AA8;font-weight:bold}' +
            '.mrt-pr-read{font-size:22px;letter-spacing:.2em;color:#2D2D3B;min-height:30px;font-weight:bold}' +
            '.mrt-pr-btns{display:flex;gap:10px;margin-top:12px}' +
            '.mrt-pr-btns button{flex:1;border-radius:9px;padding:9px 0;font-size:13px;cursor:pointer;border:1.5px solid #E0E2EA;background:#fff;color:#4E4E50}' +
            '.mrt-pr-btns .save{background:#DC282E;border-color:#DC282E;color:#fff;font-weight:bold}' +
            '</style>' +
            '<div class="mrt-pr-card">' +
              '<h4>Unlock pattern</h4>' +
              '<div class="sub">Click-drag through the dots like the customer draws it</div>' +
              '<div class="mrt-pr-grid">' +
                [1,2,3,4,5,6,7,8,9].map(function (n) {
                    return '<div class="mrt-pr-dot" data-n="' + n + '">' + n + '</div>';
                }).join('') +
              '</div>' +
              '<div class="mrt-pr-read">&nbsp;</div>' +
              '<div class="mrt-pr-btns">' +
                '<button type="button" class="clear">Clear</button>' +
                '<button type="button" class="save">Save to field</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(modal);

        var read = modal.querySelector('.mrt-pr-read');

        function refresh() {
            read.innerHTML = pattern || '&nbsp;';
            modal.querySelectorAll('.mrt-pr-dot').forEach(function (d) {
                d.classList.toggle('on', pattern.indexOf(d.getAttribute('data-n')) !== -1);
            });
        }
        function clear() { pattern = ''; refresh(); }
        function hit(dot) {
            var n = dot.getAttribute('data-n');
            if (pattern.indexOf(n) === -1) { pattern += n; refresh(); }
        }

        modal.querySelectorAll('.mrt-pr-dot').forEach(function (dot) {
            dot.addEventListener('mousedown', function (e) { e.preventDefault(); drawing = true; clear(); hit(dot); });
            dot.addEventListener('mouseenter', function () { if (drawing) hit(dot); });
        });
        document.addEventListener('mouseup', function () { drawing = false; });

        modal.querySelector('.clear').addEventListener('click', clear);
        modal.querySelector('.save').addEventListener('click', function () {
            var code = '###' + pattern;
            if (pattern && targetInput) {
                targetInput.value = code;
                targetInput.dispatchEvent(new Event('input',  { bubbles: true }));
                targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (pattern) {
                try { navigator.clipboard.writeText(code); } catch (e) { /* clipboard optional */ }
            }
            closePad();
        });
        modal.addEventListener('click', function (e) { if (e.target === modal) closePad(); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && modal.classList.contains('open')) closePad();
        });
    }

    function openPad(input) {
        buildModal();
        targetInput = input;
        pattern = '';
        modal.querySelector('.mrt-pr-read').innerHTML = '&nbsp;';
        modal.querySelectorAll('.mrt-pr-dot').forEach(function (d) { d.classList.remove('on'); });
        modal.classList.add('open');
    }
    function closePad() { if (modal) modal.classList.remove('open'); }

    /* ---------------- boot ---------------- */

    function start() {
        decorate();
        // device rows are added/re-rendered dynamically as the ticket is edited
        new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true });
    }

    // Legacy positional toggle — slot 6 of the RQ Mods `enabled` array
    try {
        chrome.storage.sync.get(['enabled']).then(function (res) {
            if (res && res.enabled !== undefined && Number(res.enabled[6]) !== 1) return;
            if (document.body) start();
            else document.addEventListener('DOMContentLoaded', start);
        }).catch(start);
    } catch (e) { start(); }
})();
