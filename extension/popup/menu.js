// Tool menu — the extension button drops down a couple of tools instead of
// going straight to the Price Calculator.
document.getElementById('calc').addEventListener('click', function () {
  location.href = 'popup.html';
});
document.getElementById('label').addEventListener('click', function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var t = (tabs && tabs[0]) || {};
    // bg fetches the tab's PDF (activeTab grant from this click), stashes it,
    // and opens the resizer tab pre-loaded — no save/upload round-trip.
    chrome.runtime.sendMessage({ type: 'label:grab', url: t.url || '', title: t.title || '' }, function () {
      window.close();
    });
  });
});
