import { Client, Events } from 'discord.js';
import { syncGuild } from '../utils/robloxSync';
import { getOAuthConfig } from '../utils/robloxOAuth';
import { startWebServer } from '../web/server';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: Client) {
  // Serveur web de la vérification par connexion Roblox (OAuth), si configuré
  const oauth = getOAuthConfig();
  if (oauth) {
    startWebServer(client, oauth);
  } else {
    console.log('ℹ️ Vérification OAuth Roblox non configurée : /verify <pseudo> (méthode par code) uniquement');
  }

  // Synchronisation périodique optionnelle (variable ROBLOX_SYNC_MINUTES, 0 = désactivée)
  const minutes = Number(process.env.ROBLOX_SYNC_MINUTES ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  console.log(`🔄 Synchronisation Roblox automatique toutes les ${minutes} minute(s)`);

  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const summary = await syncGuild(guild);
        if (summary.total > 0) {
          console.log(`🔄 ${guild.name} : ${summary.total} membres, ${summary.changed} modifiés, ${summary.failed} erreurs`);
        }
      } catch (error) {
        console.error(`❌ Synchronisation Roblox échouée pour ${guild.name}:`, error);
      }
    }
  }, minutes * 60 * 1000);
}
