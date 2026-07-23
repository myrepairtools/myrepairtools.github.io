// Tool menu — the extension button drops down a couple of tools instead of
// going straight to the Price Calculator.
document.getElementById('calc').addEventListener('click', function () {
  location.href = 'popup.html';
});
document.getElementById('label').addEventListener('click', function () {
  chrome.runtime.sendMessage({ type: 'label:grab' }, function () { window.close(); });
});
