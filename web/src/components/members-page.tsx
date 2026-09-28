import React, { useEffect, useState } from "react";
import { ApiError, apiClient } from "../api/client.js";
import type { GroupMemberSummary, GroupSummary } from "../api/types.js";
import { useMemberRevision, useRuntime } from "../runtime/runtime-context.js";
import { useFeedback } from "../ui/feedback.js";

type MembersLocation = { type: "root" } | { type: "group"; groupOpenid: string } | { type: "member"; groupOpenid: string; memberOpenid: string };
export const MEMBERS_PAGE_TITLE = "成员";
export const MEMBERS_ROOT_SECTION_TITLES = { markedBots: "已标记的机器人账号", groups: "群聊" } as const;

export function MembersPage() {
    const [location, setLocation] = useState<MembersLocation>({ type: "root" });
    const [groups, setGroups] = useState<GroupSummary[]>([]);
    const [markedBots, setMarkedBots] = useState<GroupMemberSummary[]>([]);
    const [members, setMembers] = useState<GroupMemberSummary[]>([]);
    const [member, setMember] = useState<GroupMemberSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [mutating, setMutating] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const memberRevision = useMemberRevision();
    const { confirm, notify } = useFeedback();
    const { status } = useRuntime();
    const selectedGroup = location.type === "root" ? null : groups.find((group) => group.groupOpenid === location.groupOpenid) ?? null;

    useEffect(() => {
        const controller = new AbortController();
        void (async () => {
            setLoading(true);
            try {
                const [nextGroups, nextBots] = await Promise.all([
                    apiClient.getGroups(controller.signal),
                    apiClient.getMarkedBots(controller.signal),
                ]);
                setGroups(nextGroups);
                setMarkedBots(nextBots);
                if (location.type !== "root") {
                    const nextMembers = await apiClient.getGroupMembers(location.groupOpenid, controller.signal);
                    setMembers(nextMembers);
                    if (location.type === "member") {
                        const nextMember = await apiClient.getGroupMember(location.groupOpenid, location.memberOpenid, controller.signal);
                        setMember(nextMember);
                    } else setMember(null);
                } else {
                    setMembers([]);
                    setMember(null);
                }
            } catch (cause) {
                if (cause instanceof DOMException && cause.name === "AbortError") return;
                notify("error", cause instanceof ApiError ? cause.message : "读取成员数据失败");
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [location, memberRevision, refreshKey, notify]);

    function refresh(): void { setRefreshKey((key) => key + 1); }

    async function setGroupReplies(enabled: boolean): Promise<void> {
        if (!selectedGroup || mutating) return;
        setMutating(true);
        try {
            await apiClient.setGroupRepliesEnabled(selectedGroup.groupOpenid, enabled);
            notify("success", enabled ? "已启用该群回复" : "已停用该群回复");
            refresh();
        } catch (cause) {
            notify("error", cause instanceof ApiError ? cause.message : "更新群回复设置失败");
        } finally { setMutating(false); }
    }

    async function setManualBot(enabled: boolean): Promise<void> {
        if (!member || location.type !== "member" || mutating) return;
        if (!enabled) {
            const approved = await confirm({
                title: "取消人工 Bot 标记",
                message: `确定取消 ${member.username}（${member.memberOpenid}）的人工 Bot 标记？自动识别状态不会被清除。`,
                confirmLabel: "取消标记",
                danger: true,
            });
            if (!approved) return;
        }
        setMutating(true);
        try {
            await apiClient.setMemberManualBot(member.groupOpenid, member.memberOpenid, enabled);
            notify("success", enabled ? "已标记为 Bot" : "已取消人工 Bot 标记");
            refresh();
        } catch (cause) {
            notify("error", cause instanceof ApiError ? cause.message : "更新 Bot 状态失败");
        } finally { setMutating(false); }
    }

    async function clearDetections(): Promise<void> {
        if (!member || location.type !== "member" || mutating) return;
        const approved = await confirm({
            title: "清除自动识别记录",
            message: `确定清除 ${member.username} 在此群的识别次数，并取消 auto_bot 状态？人工和平台 Bot 标记会保留。`,
            confirmLabel: "清除记录",
            danger: true,
        });
        if (!approved) return;
        setMutating(true);
        try {
            await apiClient.clearMemberDetections(member.groupOpenid, member.memberOpenid);
            notify("success", "已清除自动识别记录");
            refresh();
        } catch (cause) {
            notify("error", cause instanceof ApiError ? cause.message : "清除自动识别记录失败");
        } finally { setMutating(false); }
    }

    const groupLabel = selectedGroup ? formatGroupLabel(selectedGroup) : "群聊";
    const heading = location.type === "root" ? MEMBERS_PAGE_TITLE : location.type === "group" ? groupLabel : member?.username ?? "成员详情";

    return <React.Fragment><section className="members-page">
        <div className="page-heading">
            <div>
                <div className="eyebrow">控制中心 / 成员{location.type !== "root" ? ` / ${groupLabel}` : ""}{location.type === "member" ? ` / ${member?.username ?? "成员详情"}` : ""}</div>
                <h1>{heading}</h1>
                <p>{location.type === "root" ? "查看已标记的机器人账号与群聊成员。" : location.type === "group" ? "管理该群的回复状态与成员 Bot 信息。" : "查看成员身份来源与自动识别记录。"}</p>
            </div>
            {location.type !== "root" && <button className="button button-secondary" type="button" onClick={() => setLocation(location.type === "member" ? { type: "group", groupOpenid: location.groupOpenid } : { type: "root" })}>
                {location.type === "member" ? "返回群聊" : "返回成员"}
            </button>}
        </div>

        {location.type === "root" && <div className="members-root-columns">
            <section className="panel member-panel">
                <div className="panel-heading">
                    <div className="panel-title"><span className="panel-index">01</span><h2>{MEMBERS_ROOT_SECTION_TITLES.markedBots}</h2></div>
                    <span className="panel-hint">{markedBots.length} 个</span>
                </div>
                {markedBots.length ? <div className="member-list">
                    {markedBots.map((bot) => <MemberRow key={`${bot.groupOpenid}:${bot.memberOpenid}`} member={bot}
                        groupLabel={formatGroupLabel(groups.find((group) => group.groupOpenid === bot.groupOpenid), bot.groupOpenid)}
                        onDetails={() => setLocation({ type: "member", groupOpenid: bot.groupOpenid, memberOpenid: bot.memberOpenid })} />)}
                </div> : <p className="empty-message">{loading ? "正在载入成员…" : "暂无已标记的机器人账号"}</p>}
            </section>

            <section className="panel member-panel">
                <div className="panel-heading">
                    <div className="panel-title"><span className="panel-index">02</span><h2>{MEMBERS_ROOT_SECTION_TITLES.groups}</h2></div>
                    <span className="panel-hint">{groups.length} 个</span>
                </div>
                {groups.length ? <div className="member-list">
                    {groups.map((group) => <button className="member-group-row" key={group.groupOpenid} type="button"
                        onClick={() => setLocation({ type: "group", groupOpenid: group.groupOpenid })}>
                        <span className="member-group-main"><strong>{formatGroupLabel(group)}</strong><code>{group.groupOpenid}</code></span>
                        <span className="member-group-meta"><span>{group.memberCount} 位成员</span><span>最后活动 {formatDate(group.lastSeenAt)}</span>
                            <span className={group.repliesEnabled ? "member-reply-state enabled" : "member-reply-state disabled"}>{group.repliesEnabled ? "已启用" : "已停用"}</span></span>
                        <span className="member-group-open" aria-hidden="true">›</span>
                    </button>)}
                </div> : <p className="empty-message">{loading ? "正在载入群聊…" : "暂无群聊记录"}</p>}
            </section>
        </div>}

        {location.type === "group" && selectedGroup && <section className="panel member-detail-panel">
            <div className="member-group-summary">
                <div><span className="eyebrow">群聊身份</span><code>{selectedGroup.groupOpenid}</code></div>
                <span>{members.length} 位成员</span><span>首次出现 {formatDate(selectedGroup.firstSeenAt)}</span><span>最后活动 {formatDate(selectedGroup.lastSeenAt)}</span>
                <button className={`member-reply-toggle${selectedGroup.repliesEnabled ? " enabled" : ""}`} type="button" role="switch"
                    aria-checked={selectedGroup.repliesEnabled} disabled={mutating}
                    onClick={() => void setGroupReplies(!selectedGroup.repliesEnabled)}>
                    <span className="member-toggle-track"><span /></span><span>群聊回复 {selectedGroup.repliesEnabled ? "已启用" : "已停用"}</span>
                </button>
            </div>
            {status && !status.groupRepliesEnabled && <p className="member-global-warning" role="status">当前全局群聊回复已关闭，此设置将在全局重新启用后生效。</p>}
            <div className="panel-heading member-list-heading">
                <div className="panel-title"><span className="panel-index">01</span><h2>群成员</h2></div>
                <span className="panel-hint">{members.length} 位</span>
            </div>
            {members.length ? <div className="member-list">
                {members.map((item) => <MemberRow key={item.memberOpenid} member={item} groupLabel={groupLabel}
                    onDetails={() => setLocation({ type: "member", groupOpenid: item.groupOpenid, memberOpenid: item.memberOpenid })} />)}
            </div> : <p className="empty-message">{loading ? "正在载入群成员…" : "暂无成员记录"}</p>}
        </section>}

        {location.type === "member" && <section className="panel member-detail-panel">
            {!member ? <p className="empty-message">{loading ? "正在载入成员详情…" : "未找到该群成员"}</p> : <>
                <div className="member-detail-hero">
                    <div><span className="eyebrow">{groupLabel}</span><h2>{member.username}</h2><code>{member.memberOpenid}</code></div>
                    <BotBadges member={member} />
                </div>
                <dl className="member-facts">
                    <dt>群聊</dt><dd>{groupLabel} · <code>{member.groupOpenid}</code></dd>
                    <dt>首次出现</dt><dd>{formatDate(member.firstSeenAt)}</dd>
                    <dt>最后出现</dt><dd>{formatDate(member.lastSeenAt)}</dd>
                    <dt>群角色</dt><dd>{member.role || "未知"}</dd>
                    <dt>平台 Bot</dt><dd>{member.platformBot ? "是" : "否"}</dd>
                    <dt>人工 Bot</dt><dd>{member.manualBot ? "是" : "否"}</dd>
                    <dt>自动 Bot</dt><dd>{member.autoBot ? "是" : "否"}</dd>
                    <dt>自动识别次数</dt><dd>{member.detectionMarks}</dd>
                    <dt>最近识别</dt><dd>{member.lastDetectionAt === null ? "—" : formatDate(member.lastDetectionAt)}</dd>
                </dl>
                <div className="member-actions">
                    <button className={`button ${member.manualBot ? "button-danger" : "button-primary"}`} type="button" disabled={mutating}
                        onClick={() => void setManualBot(!member.manualBot)}>{member.manualBot ? "取消 Bot 标记" : "标记为 Bot"}</button>
                    <button className="button button-secondary" type="button" disabled={mutating || (member.detectionMarks === 0 && !member.autoBot)}
                        onClick={() => void clearDetections()}>清除识别次数</button>
                    <span>清除后 auto_bot 与识别次数归零，manual_bot 和平台 Bot 标记不变。</span>
                </div>
            </>}
        </section>}
    </section></React.Fragment>;
}

export function MemberRow({ member, groupLabel, onDetails }: { member: GroupMemberSummary; groupLabel: string; onDetails(): void }) {
    return <div className="member-row">
        <div className="member-row-identity"><strong>{member.username}</strong><code>{member.memberOpenid}</code><span>{groupLabel}</span></div>
        <div className="member-row-state"><BotBadges member={member} />
            {member.detectionMarks > 0 && <span className={`member-detection-count ${markTone(member.detectionMarks)}`}>已标记 {member.detectionMarks} 次</span>}
            <span className="member-last-seen">最后出现 {formatDate(member.lastSeenAt)}</span>
        </div>
        <button className="member-detail-button" type="button" onClick={onDetails}>详情</button>
    </div>;
}

function BotBadges({ member }: { member: GroupMemberSummary }) {
    return <span className="member-badges">
        {member.platformBot && <span className="member-badge platform">平台 Bot</span>}
        {member.manualBot && <span className="member-badge manual">手动标记</span>}
        {member.autoBot && <span className="member-badge automatic">Bot · 自动识别</span>}
    </span>;
}

function markTone(marks: number): string { return marks >= 3 ? "orange" : "yellow"; }
function formatGroupLabel(group: GroupSummary | undefined, fallbackId?: string): string {
    const name = group?.displayName?.trim();
    return name || `群聊 · ${group?.groupOpenid ?? fallbackId ?? "未知群聊"}`;
}
function formatDate(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "未知";
    return new Date(value).toLocaleString();
}
