import { Guild, GuildMember } from 'discord.js';
import type { RobloxBind, RobloxConfig } from '@prisma/client';
import { prisma } from './prisma';
import { getUser, getUserGroups, RobloxApiError } from './roblox';

export interface GuildSettings {
  config: RobloxConfig | null;
  binds: RobloxBind[];
}

export interface UpdateResult {
  linked: boolean;
  robloxId?: string;
  robloxUsername?: string;
  added: string[];
  removed: string[];
  nickname: string | null;
  warnings: string[];
}

export async function loadGuildSettings(guildId: string): Promise<GuildSettings> {
  const [config, binds] = await Promise.all([
    prisma.robloxConfig.findUnique({ where: { guildId } }),
    prisma.robloxBind.findMany({ where: { guildId } })
  ]);
  return { config, binds };
}

// Rang 0 = non-membre. Sans rang précis : tous les membres du groupe (rang >= 1).
export function bindMatches(bind: Pick<RobloxBind, 'rank' | 'minRank' | 'maxRank'>, rank: number): boolean {
  if (bind.rank !== null) return rank === bind.rank;
  const min = bind.minRank ?? 1;
  const max = bind.maxRank ?? 255;
  return rank >= min && rank <= max;
}

function buildNickname(
  template: string | null | undefined,
  vars: Record<string, string>
): string | null {
  if (!template || !template.trim()) return null;
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{${key}}`).join(value);
  }
  result = result.trim().slice(0, 32);
  return result.length > 0 ? result : null;
}

/**
 * Synchronise rôles et pseudo d'un membre avec son compte Roblox lié.
 * Ne touche qu'aux rôles gérés par le bot (rôle vérifié, rôle non vérifié, rôles des binds).
 * Lève RobloxApiError si l'API Roblox est indisponible : dans ce cas aucun rôle n'est retiré.
 */
export async function updateMember(member: GuildMember, preloaded?: GuildSettings): Promise<UpdateResult> {
  const guild = member.guild;
  const { config, binds } = preloaded ?? (await loadGuildSettings(guild.id));
  const link = await prisma.robloxLink.findUnique({ where: { discordId: member.id } });

  const result: UpdateResult = { linked: !!link, added: [], removed: [], nickname: null, warnings: [] };

  const managed = new Set<string>();
  if (config?.verifiedRoleId) managed.add(config.verifiedRoleId);
  if (config?.unverifiedRoleId) managed.add(config.unverifiedRoleId);
  for (const bind of binds) managed.add(bind.roleId);

  const target = new Set<string>();
  let desiredNickname: string | null = null;

  if (!link) {
    if (config?.unverifiedRoleId) target.add(config.unverifiedRoleId);
  } else {
    const [user, groups] = await Promise.all([getUser(link.robloxId), getUserGroups(link.robloxId)]);
    if (!user) throw new RobloxApiError('Ce compte Roblox est introuvable (supprimé ou banni ?)', 404);

    if (user.name !== link.robloxUsername) {
      await prisma.robloxLink.update({ where: { discordId: member.id }, data: { robloxUsername: user.name } });
    }
    result.robloxId = link.robloxId;
    result.robloxUsername = user.name;

    if (config?.verifiedRoleId) target.add(config.verifiedRoleId);
    for (const bind of binds) {
      const rank = groups.get(bind.groupId)?.rank ?? 0;
      if (bindMatches(bind, rank)) target.add(bind.roleId);
    }

    const mainGroup = config?.mainGroupId ? groups.get(config.mainGroupId) : undefined;
    desiredNickname = buildNickname(config?.nicknameTemplate, {
      'roblox-username': user.name,
      'display-name': user.displayName,
      'discord-name': member.user.username,
      'roblox-id': link.robloxId,
      'group-rank': mainGroup?.roleName ?? 'Guest',
      'group-rank-number': String(mainGroup?.rank ?? 0)
    });
  }

  // Rôles
  const addable: string[] = [];
  for (const id of target) {
    if (member.roles.cache.has(id)) continue;
    const role = guild.roles.cache.get(id);
    if (!role) result.warnings.push(`Un rôle configuré (${id}) n'existe plus.`);
    else if (!role.editable) result.warnings.push(`Je ne peux pas attribuer **${role.name}** (il est au-dessus de mon rôle).`);
    else addable.push(id);
  }

  const removable: string[] = [];
  for (const id of managed) {
    if (target.has(id) || !member.roles.cache.has(id)) continue;
    const role = guild.roles.cache.get(id);
    if (!role) continue;
    if (!role.editable) result.warnings.push(`Je ne peux pas retirer **${role.name}** (il est au-dessus de mon rôle).`);
    else removable.push(id);
  }

  try {
    if (addable.length) {
      await member.roles.add(addable, 'Synchronisation Roblox');
      result.added = addable;
    }
    if (removable.length) {
      await member.roles.remove(removable, 'Synchronisation Roblox');
      result.removed = removable;
    }
  } catch (error) {
    console.error('❌ Erreur lors de la modification des rôles Roblox:', error);
    result.warnings.push('Erreur lors de la modification des rôles (permission « Gérer les rôles » manquante ?).');
  }

  // Pseudo
  if (desiredNickname && member.nickname !== desiredNickname && member.displayName !== desiredNickname) {
    if (!member.manageable) {
      result.warnings.push('Je ne peux pas modifier le pseudo de ce membre (propriétaire ou rôle supérieur au mien).');
    } else {
      try {
        await member.setNickname(desiredNickname, 'Synchronisation Roblox');
        result.nickname = desiredNickname;
      } catch (error) {
        console.error('❌ Erreur lors du changement de pseudo:', error);
        result.warnings.push('Impossible de modifier le pseudo (permission « Gérer les pseudos » manquante ?).');
      }
    }
  }

  return result;
}

const syncing = new Set<string>();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function isSyncing(guildId: string): boolean {
  return syncing.has(guildId);
}

export interface SyncSummary {
  total: number;
  changed: number;
  failed: number;
}

// Mise à jour de tous les membres d'un serveur, en série pour respecter les limites de l'API Roblox
export async function syncGuild(guild: Guild): Promise<SyncSummary> {
  if (syncing.has(guild.id)) throw new Error('Une synchronisation est déjà en cours sur ce serveur.');

  const settings = await loadGuildSettings(guild.id);
  const summary: SyncSummary = { total: 0, changed: 0, failed: 0 };
  if (!settings.config && settings.binds.length === 0) return summary;

  syncing.add(guild.id);
  try {
    const members = await guild.members.fetch();
    for (const member of members.values()) {
      if (member.user.bot) continue;
      summary.total++;
      try {
        const result = await updateMember(member, settings);
        if (result.added.length || result.removed.length || result.nickname) summary.changed++;
        if (result.linked) await sleep(700);
      } catch (error) {
        summary.failed++;
        if (error instanceof RobloxApiError) await sleep(2000);
      }
    }
  } finally {
    syncing.delete(guild.id);
  }
  return summary;
}
