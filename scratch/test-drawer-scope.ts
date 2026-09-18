// Test how :is() and locator.locator() behave
const d1 = ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"])';
const sel1 = `${d1} label.ssrc__label, ${d1} .singleselect-radiobutton`;
console.log('Formatted :is() selector:');
console.log(sel1);

const parts = sel1.split(',').map(s => s.trim());
console.log('\nPart 0:', parts[0]);
console.log('Part 1:', parts[1]);
console.log('Does Part 0 have child selector?:', parts[0].includes('label.ssrc__label'));
console.log('Does Part 1 have child selector?:', parts[1].includes('.singleselect-radiobutton'));
