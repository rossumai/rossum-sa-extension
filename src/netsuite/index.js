function displayFieldName(node, fieldId) {
  const div = document.createElement('div');
  div.className = 'rossum-sa-extension-netsuite-field-name';
  div.textContent = fieldId;
  node.appendChild(div);
}

chrome.storage.local.get(['netsuiteFieldNamesEnabled']).then((result) => {
  if (result.netsuiteFieldNamesEnabled !== true) return;

  const linksWithLabel = document.querySelectorAll("span[id$='_lbl'] a");
  for (const link of linksWithLabel) {
    const onClick = link.getAttribute('onclick');
    if (onClick == null || !onClick.includes('nlFieldHelp')) continue;

    const resultArray = onClick.match(/"(?<word>[^"]*)"/g) || onClick.match(/'(?<word>[^']*)'/g);
    if (resultArray && resultArray.length > 1) {
      const fieldId = resultArray[1].replace(/['"]/g, '');
      displayFieldName(link, fieldId);
    }
  }
});
