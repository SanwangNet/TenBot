import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { NormalizedQqMessage } from "../message/normalize-message.js";
import { logger, truncateLogText } from "../../shared/logger.js";

interface Member {
    memberOpenid: string;
    username: string;
    role?: string;
    firstSeenAt: number;
    lastSeenAt: number;
}

const MAX_MEMBERS = 50;
const groups = new Map<string, Map<string, Member>>();
export const DEFAULT_KNOWN_MEMBERS_PATH = resolve(process.cwd(), "data", "known-members.json");
let storagePath = DEFAULT_KNOWN_MEMBERS_PATH;
let blocked = false;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<void> | undefined;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFile(value: unknown): Map<string, Map<string, Member>> {
    if (!record(value) || value.version !== 1 || !record(value.groups)) {
        throw new Error("invalid known-members schema");
    }
    const loaded = new Map<string, Map<string, Member>>();
    for (const [groupId, rawGroup] of Object.entries(value.groups)) {
        if (!groupId || !record(rawGroup)) throw new Error("invalid group");
        const members = new Map<string, Member>();
        for (const [id, raw] of Object.entries(rawGroup)) {
            if (!id || !record(raw) || typeof raw.username !== "string" || !raw.username ||
                (raw.role !== undefined && typeof raw.role !== "string") ||
                typeof raw.firstSeenAt !== "number" || !Number.isFinite(raw.firstSeenAt) ||
                typeof raw.lastSeenAt !== "number" || !Number.isFinite(raw.lastSeenAt)) {
                throw new Error("invalid member");
            }
            members.set(id, {
                memberOpenid: id,
                username: raw.username,
                role: raw.role as string | undefined,
                firstSeenAt: raw.firstSeenAt,
                lastSeenAt: raw.lastSeenAt,
            });
        }
        const newest = [...members.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
            .slice(0, MAX_MEMBERS);
        loaded.set(groupId, new Map(newest.map((member) => [member.memberOpenid, member])));
    }
    return loaded;
}

function snapshot(): string {
    const saved: { version: 1; groups: Record<string, Record<string, Omit<Member, "memberOpenid">>> } =
        { version: 1, groups: Object.create(null) as Record<string, Record<string, Omit<Member, "memberOpenid">>> };
    for (const [groupId, members] of groups) {
        const group = Object.create(null) as Record<string, Omit<Member, "memberOpenid">>;
        for (const member of members.values()) {
            group[member.memberOpenid] = {
                username: member.username,
                ...(member.role === undefined ? {} : { role: member.role }),
                firstSeenAt: member.firstSeenAt,
                lastSeenAt: member.lastSeenAt,
            };
        }
        saved.groups[groupId] = group;
    }
    return JSON.stringify(saved, null, 2) + "\n";
}

/** A damaged file stays untouched; memory continues and writes are disabled for this run. */
export async function loadKnownMembers(path = DEFAULT_KNOWN_MEMBERS_PATH): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (writing) await writing;
    storagePath = path;
    groups.clear();
    dirty = false;
    blocked = false;
    try {
        await mkdir(dirname(path), { recursive: true });
        const loaded = parseFile(JSON.parse(await readFile(path, "utf8")) as unknown);
        for (const [groupId, members] of loaded) groups.set(groupId, members);
        logger.info("[Members] loaded");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        groups.clear();
        blocked = true;
        logger.error("[Members] persistence error: file preserved", error);
    }
}

async function writeSnapshot(text: string): Promise<void> {
    await mkdir(dirname(storagePath), { recursive: true });
    const temp = storagePath + ".tmp";
    await writeFile(temp, text, "utf8");
    await rename(temp, storagePath);
}

/** One writer drains all changes, including changes arriving while the file is written. */
export function flushKnownMembers(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (writing) return writing;
    if (!dirty || blocked) return Promise.resolve();
    writing = (async () => {
        while (dirty && !blocked) {
            dirty = false;
            try {
                await writeSnapshot(snapshot());
                logger.debug("[Members] saved");
            } catch (error) {
                dirty = true;
                logger.error("[Members] persistence error", error);
                return;
            }
        }
    })().finally(() => { writing = undefined; });
    return writing;
}

function scheduleSave(): void {
    if (blocked) return;
    dirty = true;
    if (!timer) {
        timer = setTimeout(() => {
            timer = undefined;
            void flushKnownMembers();
        }, 200);
    }
}

function memberMap(groupId: string | undefined, create = false): Map<string, Member> | undefined {
    if (!groupId) return undefined;
    let members = groups.get(groupId);
    if (!members && create) {
        members = new Map();
        groups.set(groupId, members);
    }
    return members;
}

function roleName(role?: string): string {
    if (role === "owner") return "群主";
    if (role === "admin" || role === "administrator") return "管理员";
    return "成员";
}

function learn(groupId: string, id: string, username: string, role?: string): void {
    const members = memberMap(groupId, true)!;
    const now = Date.now();
    const current = members.get(id);
    if (!current) {
        members.set(id, { memberOpenid: id, username, role, firstSeenAt: now, lastSeenAt: now });
        logger.info("[Members] learned " + truncateLogText(username, 60) + " (" + roleName(role) + ")");
        if (members.size > MAX_MEMBERS) {
            const oldest = [...members.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
            members.delete(oldest.memberOpenid);
        }
        scheduleSave();
        return;
    }
    current.lastSeenAt = now;
    if (current.username !== username) {
        logger.info("[Members] renamed " + truncateLogText(current.username, 60) +
            " -> " + truncateLogText(username, 60));
        current.username = username;
        scheduleSave();
    }
    if (role !== undefined && role !== current.role) {
        logger.info("[Members] role " + truncateLogText(username, 60) + " " +
            (current.role ?? "member") + " -> " + role);
        current.role = role;
        scheduleSave();
    }
}

export function rememberKnownMember(message: NormalizedQqMessage): void {
    if (message.kind !== "group" || !message.groupId) return;
    if (!message.authorIsBot && message.author) {
        const id = message.author.member_openid ?? message.author.memberOpenid ?? message.author.id;
        const name = message.author.username ?? message.author.nickname;
        const role = message.author.member_role ?? message.author.memberRole;
        if (typeof id === "string" && id && typeof name === "string" && name) {
            learn(message.groupId, id, name, typeof role === "string" ? role : undefined);
        }
    }
    for (const mention of message.mentions) {
        if (!mention.isBot && !mention.isSelf && mention.memberOpenid && mention.username) {
            learn(message.groupId, mention.memberOpenid, mention.username, mention.role);
        }
    }
}

export function getKnownMembers(message: NormalizedQqMessage): Member[] {
    if (message.kind !== "group") return [];
    return [...(memberMap(message.groupId)?.values() ?? [])]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function getKnownMemberNameById(groupId: string | undefined, id: string): string | undefined {
    return memberMap(groupId)?.get(id)?.username;
}

export function buildKnownMembersContext(message: NormalizedQqMessage): string {
    const members = getKnownMembers(message).slice(0, 20);
    if (!members.length) return "";
    const counts = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const member of members) counts.set(member.username, (counts.get(member.username) ?? 0) + 1);
    const lines = members.map((member) => {
        const ordinal = (seen.get(member.username) ?? 0) + 1;
        seen.set(member.username, ordinal);
        const duplicate = (counts.get(member.username) ?? 0) > 1
            ? "；同名成员 " + ordinal + "/" + counts.get(member.username) : "";
        return member.username + "（" + roleName(member.role) + duplicate + "）";
    });
    return [
        "<known_group_members>", ...lines, "</known_group_members>", "",
        "<mention_capability>",
        "上面是你目前认识的群友。",
        "如果确实需要真正 @ 某个已知群友，请在 qq_reply 的 mentions 中填写列表里的准确昵称。",
        "例如需要 @ 尘柒喵时，mentions 填 [\"尘柒喵\"]。",
        "只有真正需要 @ 对方时才填写 mentions，不要每次提到名字都 @。",
        "不要填写不在已知群友列表里的人。",
        "</mention_capability>",
    ].join("\n");
}

function findUnique(message: NormalizedQqMessage, username: string): Member | null {
    const matches = getKnownMembers(message).filter((member) => member.username === username);
    return matches.length === 1 ? matches[0] : null;
}

function mentionTag(member: Member | null, name: string): string {
    return member && /^[A-Za-z0-9_-]+$/.test(member.memberOpenid)
        ? '<qqbot-at-user id="' + member.memberOpenid + '" />'
        : "@" + name.replace(/[<>]/g, "");
}

export function renderMentions(
    message: NormalizedQqMessage,
    text: string,
): { sendText: string; contextText: string } {
    const pattern = /<mention>([^<]{1,64})<\/mention>/g;
    return {
        sendText: text.replace(pattern, (_match, name: string) =>
            mentionTag(findUnique(message, name.trim()), name.trim())),
        contextText: text.replace(pattern, (_match, name: string) => "@" + name.trim()),
    };
}

export function renderStructuredMentions(
    message: NormalizedQqMessage,
    content: string,
    mentions: string[],
): { sendText: string; contextText: string } {
    const safeContent = content.replace(/<qqbot-at-user\b[^>]*\/?>/gi, "");
    const rendered = renderMentions(message, safeContent);
    const names = [...new Set(mentions.map((name) => name.trim()).filter(Boolean))]
        .filter((name) => !safeContent.includes("<mention>" + name + "</mention>"));
    return {
        sendText: [...names.map((name) => mentionTag(findUnique(message, name), name)), rendered.sendText]
            .filter(Boolean).join(" "),
        contextText: [...names.map((name) => "@" + name), rendered.contextText]
            .filter(Boolean).join(" "),
    };
}
