import { Zernio } from "@zernio/node";

// Reads ZERNIO_API_KEY from the environment.
const zernio = new Zernio();

/**
 * Blocks the user in WhatsApp itself (Meta's block list). From then on their
 * messages never reach Zernio or this server, so they cost nothing.
 * Meta only allows blocking users who wrote to you in the last 24 hours,
 * which is always the case here.
 */
export async function blockWhatsAppUser({ accountId, user }: { accountId: string; user: string }) {
	try {
		const { data } = await zernio.whatsapp.blockWhatsAppUsers({
			body: { accountId, users: [user] },
		});
		if (!data?.blocked?.length) {
			console.error(`[Zernio] Could not block ${user}:`, data?.failed);
			return false;
		}
		return true;
	} catch (error) {
		console.error(`[Zernio] Could not block ${user}:`, error);
		return false;
	}
}

export async function unblockWhatsAppUser({ accountId, user }: { accountId: string; user: string }) {
	try {
		const { data } = await zernio.whatsapp.unblockWhatsAppUsers({
			body: { accountId, users: [user] },
		});
		return Boolean(data?.unblocked?.length);
	} catch (error) {
		console.error(`[Zernio] Could not unblock ${user}:`, error);
		return false;
	}
}
