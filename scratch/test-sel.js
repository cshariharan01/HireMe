const CHATBOT_DRAWER = 'div.chatbot_DrawerContentWrapper, div[class*="chatbot"]';
const CHATBOT_TEXT_INPUT = [
  'div[contenteditable="true"].textArea',
  'div[contenteditable="true"][class*="textArea"]',
  'div.textAreaWrapper [contenteditable="true"]',
  'div[contenteditable="true"]',
];
console.log(`${CHATBOT_DRAWER} ${CHATBOT_TEXT_INPUT}`);
