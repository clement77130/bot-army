import http, { IncomingMessage, ServerResponse } from 'http';
import { Client, EmbedBuilder } from 'discord.js';
import { prisma } from '../utils/prisma';
import {
  OAuthConfig,
  buildDiscordAuthUrl,
  buildRobloxAuthUrl,
  pendingInteractions,
  SESSION_TTL_MS
} from '../utils/robloxOAuth';
import { updateMember } from '../utils/robloxSync';
import { buildUpdateEmbed } from '../utils/robloxEmbeds';

const COOKIE_NAME = 'ats_sid';
const FETCH_TIMEOUT_MS = 10_000;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function renderPage(title: string, message: string, ok: boolean): string {
  const color = ok ? '#00b06f' : '#e5484d';
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Armée de Terre RBLX</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1f22;color:#f2f3f5;font-family:system-ui,sans-serif}
  .card{max-width:440px;margin:24px;padding:32px;border-radius:12px;background:#2b2d31;text-align:center;border-top:4px solid ${color}}
  h1{font-size:22px;margin:0 0 12px}p{margin:0;line-height:1.5;color:#b5bac1}small{display:block;margin-top:20px;color:#80848e}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><small>Armée de Terre RBLX</small></div></body></html>`;
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    ...headers
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end();
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

async function fetchJson<T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${url} a répondu ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getValidSession(id: string | null | undefined) {
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const session = await prisma.robloxOAuthSession.findUnique({ where: { id } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.robloxOAuthSession.delete({ where: { id } }).catch(() => {});
    return null;
  }
  return session;
}

const EXPIRED = 'Ce lien a expiré ou a déjà été utilisé. Retournez sur Discord et relancez /verify.';

async function handleRequest(req: IncomingMessage, res: ServerResponse, client: Client, config: OAuthConfig) {
  if (req.method !== 'GET') return send(res, 405, renderPage('Méthode non autorisée', 'Cette page n\'accepte que les requêtes GET.', false));

  const url = new URL(req.url ?? '/', 'http://localhost');
  const secure = config.publicUrl.startsWith('https://');
  const cookies = parseCookies(req.headers.cookie);

  if (url.pathname === '/health') return send(res, 200, 'ok');

  // Étape 0 : arrivée depuis le bouton Discord -> on pose le cookie qui lie ce navigateur à la session, puis connexion Discord
  const start = url.pathname.match(/^\/verify\/([a-f0-9]{64})$/);
  if (start) {
    const session = await getValidSession(start[1]);
    if (!session) return send(res, 400, renderPage('Lien expiré', EXPIRED, false));

    const cookie = `${COOKIE_NAME}=${session.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
    return redirect(res, buildDiscordAuthUrl(config, session.id), { 'Set-Cookie': cookie });
  }

  // Étape 1 : retour de Discord -> on vérifie que le navigateur est bien celui du membre, puis connexion Roblox
  if (url.pathname === '/callback/discord') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');

    if (url.searchParams.get('error') || !code) {
      return send(res, 400, renderPage('Connexion annulée', 'La connexion Discord a été annulée. Relancez /verify pour recommencer.', false));
    }

    const session = await getValidSession(state);
    if (!session || cookies[COOKIE_NAME] !== session.id) {
      return send(res, 400, renderPage('Lien invalide', EXPIRED, false));
    }

    const token = await fetchJson<{ access_token: string }>('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${config.publicUrl}/callback/discord`
      }).toString()
    });

    const me = await fetchJson<{ id: string }>('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });

    if (me.id !== session.discordId) {
      return send(res, 403, renderPage(
        'Mauvais compte Discord',
        'Vous êtes connecté à Discord avec un autre compte que celui qui a lancé /verify. Reconnectez-vous avec le bon compte.',
        false
      ));
    }

    await prisma.robloxOAuthSession.update({ where: { id: session.id }, data: { discordOk: true } });
    return redirect(res, buildRobloxAuthUrl(config, session.id, session.codeVerifier));
  }

  // Étape 2 : retour de Roblox -> on récupère l'identité Roblox et on crée le lien
  if (url.pathname === '/callback/roblox') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');

    if (url.searchParams.get('error') || !code) {
      return send(res, 400, renderPage('Connexion annulée', 'La connexion Roblox a été annulée. Relancez /verify pour recommencer.', false));
    }

    const session = await getValidSession(state);
    if (!session || !session.discordOk || cookies[COOKIE_NAME] !== session.id) {
      return send(res, 400, renderPage('Lien invalide', EXPIRED, false));
    }

    // À usage unique : la session est consommée avant tout appel externe
    const consumed = await prisma.robloxOAuthSession.deleteMany({ where: { id: session.id } });
    if (consumed.count === 0) return send(res, 400, renderPage('Lien invalide', EXPIRED, false));

    const token = await fetchJson<{ access_token: string }>('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.robloxClientId,
        client_secret: config.robloxClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${config.publicUrl}/callback/roblox`,
        code_verifier: session.codeVerifier
      }).toString()
    });

    const roblox = await fetchJson<{ sub: string; preferred_username?: string; name?: string }>(
      'https://apis.roblox.com/oauth/v1/userinfo',
      { headers: { Authorization: `Bearer ${token.access_token}` } }
    );

    const robloxUsername = roblox.preferred_username ?? roblox.name ?? roblox.sub;

    await prisma.robloxLink.upsert({
      where: { discordId: session.discordId },
      create: { discordId: session.discordId, robloxId: roblox.sub, robloxUsername },
      update: { robloxId: roblox.sub, robloxUsername, linkedAt: new Date() }
    });

    // Rôles + pseudo, puis mise à jour du message Discord d'origine
    const embeds = [
      new EmbedBuilder().setColor('#00b06f').setTitle('✅ Compte vérifié').setDescription(`Votre compte Discord est maintenant lié à **${robloxUsername}**.`)
    ];

    try {
      const guild = client.guilds.cache.get(session.guildId);
      const member = guild ? await guild.members.fetch(session.discordId).catch(() => null) : null;
      if (member) embeds.push(buildUpdateEmbed(await updateMember(member), '🔄 Rôles et pseudo mis à jour'));
    } catch (error) {
      console.error('❌ Mise à jour après liaison OAuth échouée:', error);
      embeds[0].setFooter({ text: 'Compte lié, mais la mise à jour des rôles a échoué. Utilisez /update.' });
    }

    const interaction = pendingInteractions.get(session.id);
    pendingInteractions.delete(session.id);
    await interaction?.editReply({ content: '', embeds, components: [] }).catch(() => {});

    return send(res, 200, renderPage('Compte vérifié', `Votre compte Discord est lié à ${robloxUsername}. Vous pouvez fermer cette page et retourner sur Discord.`, true));
  }

  return send(res, 404, renderPage('Page introuvable', 'Cette page n\'existe pas.', false));
}

export function startWebServer(client: Client, config: OAuthConfig) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, client, config).catch(error => {
      console.error('❌ Erreur du serveur web:', error);
      if (!res.headersSent) {
        send(res, 500, renderPage('Erreur', 'Une erreur est survenue. Relancez /verify dans quelques instants.', false));
      } else {
        res.end();
      }
    });
  });

  server.on('error', error => console.error('❌ Impossible de démarrer le serveur web:', error));
  server.listen(config.port, config.host, () => {
    console.log(`🌐 Serveur de vérification Roblox sur http://${config.host}:${config.port} (public : ${config.publicUrl})`);
  });
}
