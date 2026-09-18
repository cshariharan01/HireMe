const CHATBOT_DRAWER = 'div.chatbot_DrawerContentWrapper, div[class*="chatbot"]';
const CHATBOT_TEXT_INPUT = [
  'div[contenteditable="true"].textArea',
  'div[contenteditable="true"][class*="textArea"]',
  'div.textAreaWrapper [contenteditable="true"]',
  'div[contenteditable="true"]',
  'div[placeholder*="Type message" i]',
  'input[type="text"].chatbot_Input',
  'input.chatbot_Input',
  'input[placeholder*="Type message" i]',
  'textarea[placeholder*="Type message" i]',
  'input[type="text"]',
  'textarea',
].join(', ');

const buggySelector = `${CHATBOT_DRAWER} ${CHATBOT_TEXT_INPUT}`;
console.log('--- BUGGY SELECTOR FIRST 3 SELECTORS ---');
const parts = buggySelector.split(',').map(s => s.trim());
console.log('Selector #0:', parts[0]);
console.log('Selector #1:', parts[1]);
console.log('Selector #2:', parts[2]);

console.log('\nNotice that Selector #0 is just: "' + parts[0] + '"! It matches the entire drawer container, NOT an input field!');
