// Usage: npm run unblock -- <zernioAccountId> <phone>
// A WhatsApp block has no expiry: use this when you blocked a real customer.
import { unblockWhatsAppUser } from "./zernio.js";

const [accountId, user] = process.argv.slice(2);
if (!accountId || !user) {
	console.error("Usage: npm run unblock -- <zernioAccountId> <phone>");
	process.exit(1);
}

const result = await unblockWhatsAppUser({ accountId, user });
console.log(result ? `Unblocked ${user}` : `Could not unblock ${user}`);
