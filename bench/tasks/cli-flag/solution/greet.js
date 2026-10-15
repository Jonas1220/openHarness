const args = process.argv.slice(2);
const shout = args.includes('--shout');
const name = args.find((a) => a !== '--shout') ?? 'world';
const greeting = `Hello, ${name}!`;
console.log(shout ? greeting.toUpperCase() : greeting);
