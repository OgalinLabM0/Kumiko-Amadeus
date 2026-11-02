import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../services/db';
import { previewMemoryMaintenance, runMemoryMaintenance, type MemoryMaintenancePreview } from '../../services/memoryMaintenance';

export function MemoryMaintenanceSection({ language, isDarkMode }: { language: 'zh' | 'en'; isDarkMode: boolean }) {
  const zh = language === 'zh';
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<MemoryMaintenancePreview | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [agree, setAgree] = useState(false);
  const [agreeContext, setAgreeContext] = useState(false);
  const [agreeUnknownImages, setAgreeUnknownImages] = useState(false);
  const [agreeUnknownVoices, setAgreeUnknownVoices] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const messages = useLiveQuery(() => expanded ? db.messages.orderBy('timestamp').reverse()
    .filter(row => !query.trim() || row.text.includes(query.trim())).limit(100).toArray() : Promise.resolve([]), [query, expanded], []);
  const latest = useLiveQuery(() => db.memoryCorrections.orderBy('createdAt').last(), [], undefined);
  const showPreview = async () => {
    setBusy(true); setError(''); setAgree(false); setAgreeContext(false); setAgreeUnknownImages(false); setAgreeUnknownVoices(false);
    try { setPreview(await previewMemoryMaintenance([...selected])); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!preview || !agree || (preview.contextDerived?.length > 0 && !agreeContext) || (preview.unknownUnreferencedImages?.length > 0 && !agreeUnknownImages) || (preview.unknownUnreferencedVoices?.length > 0 && !agreeUnknownVoices)) return;
    setBusy(true); setError('');
    try { await runMemoryMaintenance(preview, preview.legacyDerivedCount > 0, agreeContext, agreeUnknownImages, agreeUnknownVoices); window.location.reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return <section className={`mt-4 rounded-2xl border p-4 ${isDarkMode ? 'border-white/10 bg-white/5 text-[#f5ebdc]' : 'border-stone-200 bg-white text-[#49301f]'}`}>
    <button type="button" className="font-semibold" onClick={() => setExpanded(value => !value)}>{zh ? '记忆维护：清除错误内容' : 'Memory maintenance: remove incorrect content'}</button>
    <p className="mt-2 text-sm opacity-75">{zh ? '普通删除聊天只隐藏你的气泡。这里会清除所选记录及关联记忆，不能撤销。仍被保留消息引用的共享媒体会保留，并在预览中列出。' : 'Deleting a chat bubble only changes your view. This operation removes selected records and related memories and cannot be undone. Shared media referenced by retained messages is kept and listed in the preview.'}</p>
    {latest && <p className="mt-2 text-sm">{latest.status === 'completed'
      ? (latest.sharedVoicesRetained?.length
        ? (zh ? `最近一次清理已核验；${latest.sharedVoicesRetained.length} 个仍被保留消息引用的共享语音未清除。有效来源的索引逐步补建。` : `The last removal was verified; ${latest.sharedVoicesRetained.length} shared voice files remain because retained messages reference them. Valid sources are reindexed.`)
        : (zh ? '最近一次清理已核验。有效来源的索引按后台状态逐步补建。' : 'The last removal was verified. Valid sources are reindexed through the background queue.'))
      : (zh ? '有未完成的维护。请重新启动以继续，完成前数据保持保护。' : 'Maintenance is unfinished. Restart to resume; data remains protected.')}</p>}
    {expanded && <div className="mt-3 space-y-3">
      <input className="w-full rounded-lg border bg-transparent p-2" value={query} onChange={e => { setQuery(e.target.value); setPreview(null); }} placeholder={zh ? '查找原始消息，包括已从你的聊天中删除的消息' : 'Find source messages, including hidden bubbles'} />
      <div className="max-h-64 overflow-y-auto space-y-2">
        {messages.map(message => <label key={message.id} className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={selected.has(message.id)} onChange={e => { const next = new Set(selected); e.target.checked ? next.add(message.id) : next.delete(message.id); setSelected(next); setPreview(null); }} />
          <span className="whitespace-pre-wrap break-words">{message.role === 'user' ? (zh ? '你：' : 'You: ') : (zh ? '久美子：' : 'Kumiko: ')}{message.text.slice(0, 300)}</span>
        </label>)}
      </div>
      <button disabled={busy || !selected.size} onClick={() => void showPreview()} className="rounded-lg border px-3 py-2 disabled:opacity-40">{zh ? `预览影响范围（已选 ${selected.size} 条）` : `Preview impact (${selected.size} selected)`}</button>
      {preview && <div className="space-y-2 rounded-lg border border-amber-500/40 p-3 text-sm">
        <p>{zh ? `将清除 ${preview.affectedMessages.length} 条原文或派生回复；日记 ${preview.artifacts.kumikoDiary || 0} 份、片段 ${preview.artifacts.dailyFragments || 0} 条、对话索引 ${preview.artifacts.episodes || 0} 项、向量 ${preview.artifacts.vectors || 0} 项。` : `Remove ${preview.affectedMessages.length} source/derived messages, ${preview.artifacts.kumikoDiary || 0} diaries, ${preview.artifacts.dailyFragments || 0} fragments and ${preview.artifacts.vectors || 0} vectors.`}</p>
        {preview.legacyDerivedCount > 0 && <p>{zh ? `另有 ${preview.legacyDerivedCount} 项旧私人派生内容缺少可靠来源。本次范围包含这些旧摘要、笔记、锚点、日记或模型回复的清除；未选择的用户原话、官方资料和仍被引用的共享媒体保留。过去的回复不会重新编写。` : `${preview.legacyDerivedCount} older private derivatives lack reliable provenance. This scope includes removing those summaries, notes, anchors, diaries or model replies. Unselected user originals, official material and shared media remain. Past replies are not rewritten.`}</p>}
        <details><summary>{zh ? '查看将清除的消息' : 'Messages to remove'}</summary><ul className="max-h-52 overflow-y-auto">{preview.affectedMessages.map(row => <li className="py-1 whitespace-pre-wrap break-words" key={row.id}>{row.text.slice(0, 300)}</li>)}</ul></details>
        <p>{zh ? `摘要、笔记等资料：${preview.artifacts.privateKeysAffected || 0} 项受影响，${preview.artifacts.privateKeysUnknown || 0} 项来源不明；${preview.artifacts.privateKeysRetained || 0} 项已核验无关并保留。状态记录将清除 ${preview.artifacts.stateCommitsAffected || 0} 项中的相关文字，已经发生的情绪不倒算。` : `Private memory: ${preview.artifacts.privateKeysAffected || 0} affected, ${preview.artifacts.privateKeysUnknown || 0} untraceable and ${preview.artifacts.privateKeysRetained || 0} verified unrelated assets. Copied text in ${preview.artifacts.stateCommitsAffected || 0} state records is removed; past feelings are not reversed.`}</p>
        <p>{zh ? `提醒：${preview.artifacts.remindersAffected || 0} 项依赖被清内容，将停止并核对系统撤销；${preview.artifacts.remindersSourceTextUnknown || 0} 项来源不明，只清除原话副本，保留提醒本身。` : `Reminders: ${preview.artifacts.remindersAffected || 0} affected reminders will be cancelled and checked. ${preview.artifacts.remindersSourceTextUnknown || 0} untraceable reminders retain their schedules while copied source text is removed.`}</p>
        {!!preview.contextDerived?.length && <div className="rounded-lg border border-amber-600/40 p-2 space-y-2">
          <p>{zh ? `另有 ${preview.contextDerived.length} 项派生材料曾在输入中接触目标内容。这不表示它们都写错了，但无法自动证明未复制或引用。以下范围需要单独确认；不确认则本次不修改任何数据。` : `${preview.contextDerived.length} derived items were exposed to the selected input. This does not prove they are wrong, but we cannot prove they contain no copy or reference. This separate scope needs your confirmation; otherwise nothing is changed.`}</p>
          <details><summary>{zh ? '查看疑似受影响的范围' : 'Review potentially affected items'}</summary><ul className="max-h-52 overflow-y-auto">{preview.contextDerived.map(row => <li className="py-1 whitespace-pre-wrap break-words" key={`${row.kind}:${row.id}`}>{row.text || `${row.kind}: ${row.id}`}</li>)}</ul></details>
          <label className="flex items-start gap-2"><input type="checkbox" checked={agreeContext} onChange={e => setAgreeContext(e.target.checked)} /><span>{zh ? '我已核对上述疑似范围，同意一并清除列出的派生材料。' : 'I reviewed this potential scope and agree to remove the listed derived items.'}</span></label>
        </div>}
        <p>{zh ? `应用管理的备份文件：${preview.managedBackups.length} 个，将一并删除。` : `${preview.managedBackups.length} app-managed backup files will also be removed.`}</p>
        <p>{zh ? `已登记的关联语音文件 ${preview.artifacts.registeredVoicesAffected || 0} 个也在清理范围内，包括生成后尚未保存为气泡的文件；共享引用会保留。` : `${preview.artifacts.registeredVoicesAffected || 0} registered related voice files are also included, even if no bubble was saved. Shared references are retained.`}</p>
        <p>{zh ? `已登记的关联图片 ${preview.artifacts.registeredImagesAffected || 0} 张会纳入清理；仍被保留消息引用的共享图片会保留。` : `${preview.artifacts.registeredImagesAffected || 0} registered related images are included; images referenced by retained messages remain.`}</p>
        {!!preview.unknownUnreferencedImages?.length && <div className="rounded-lg border border-amber-600/40 p-2 space-y-2">
          <p>{zh ? `另有 ${preview.unknownUnreferencedImages.length} 张应用内图片没有可追溯来源，也没有消息引用，可能包含尚未发送的草稿图片。必须单独确认清除这些图片才能继续。` : `${preview.unknownUnreferencedImages.length} app images have no traceable source or message reference and may include unsent drafts. Separately confirm removing them to continue.`}</p>
          <details><summary>{zh ? '查看图片标识' : 'View image identifiers'}</summary><ul className="max-h-40 overflow-y-auto">{preview.unknownUnreferencedImages.map(id => <li className="break-all" key={id}>{id}</li>)}</ul></details>
          <label className="flex items-start gap-2"><input type="checkbox" checked={agreeUnknownImages} onChange={e => setAgreeUnknownImages(e.target.checked)} /><span>{zh ? '我同意清除上述无来源且无消息引用的图片，包括可能的未发送草稿。' : 'I agree to remove these untraceable unreferenced images, including possible unsent drafts.'}</span></label>
        </div>}
        {!!preview.unknownUnreferencedVoices?.length && <div className="rounded-lg border border-amber-600/40 p-2 space-y-2">
          <p>{zh ? `应用私有目录还有 ${preview.unknownUnreferencedVoices.length} 个无登记、无消息或任务引用的旧语音文件。必须单独确认清除才能继续。` : `${preview.unknownUnreferencedVoices.length} private voice files have no registration or message or task reference. Separately confirm their removal to continue.`}</p>
          <details><summary>{zh ? '查看语音标识' : 'View voice identifiers'}</summary><ul className="max-h-40 overflow-y-auto">{preview.unknownUnreferencedVoices.map(id => <li className="break-all" key={id}>{id}</li>)}</ul></details>
          <label className="flex items-start gap-2"><input type="checkbox" checked={agreeUnknownVoices} onChange={e => setAgreeUnknownVoices(e.target.checked)} /><span>{zh ? '我同意清除上述无来源且无引用的旧语音。' : 'I agree to remove these untraceable unreferenced voice files.'}</span></label>
        </div>}
        {!!preview.sharedVoicesRetained?.length && <details><summary>{zh ? `${preview.sharedVoicesRetained.length} 个共享语音仍被保留消息引用，将保留且不会清除` : `${preview.sharedVoicesRetained.length} shared voice files are referenced by retained messages and will not be removed`}</summary><ul className="max-h-40 overflow-y-auto">{preview.sharedVoicesRetained.map(item => <li className="break-all" key={item.id}>{item.id} — {item.messageIds.join(', ')}</li>)}</ul></details>}
        <p>{zh ? `后台任务：${preview.artifacts.runtimeJobsAffected || 0} 项依赖错误内容，${preview.artifacts.runtimeJobsUnknown || 0} 项无法确认来源，将停止并清除载荷；${preview.artifacts.runtimeJobsRetained || 0} 项可核验为无关，会接续处理。` : `Background jobs: ${preview.artifacts.runtimeJobsAffected || 0} affected and ${preview.artifacts.runtimeJobsUnknown || 0} untraceable jobs will be stopped and cleared; ${preview.artifacts.runtimeJobsRetained || 0} verified unrelated jobs are retained.`}</p>
        {!!preview.managedBackups.length && <ul>{preview.managedBackups.map(file => <li className="break-all" key={file.path}>{file.path}</li>)}</ul>}
        <p>{zh ? '另外导出的文件、系统备份与服务商已收到的内容不受此操作控制。清理不表示物理介质取证级擦除。' : 'Separate exports, system backups and provider copies are outside this operation. This is not forensic erasure of physical media.'}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /><span>{zh ? '我确认以上范围，包括列出的旧派生内容、备份以及注明保留的共享媒体。' : 'I confirm the scope above, including listed derivatives, backups, and shared media identified for retention.'}</span></label>
        <button disabled={busy || !agree || (!!preview.contextDerived?.length && !agreeContext) || (!!preview.unknownUnreferencedImages?.length && !agreeUnknownImages) || (!!preview.unknownUnreferencedVoices?.length && !agreeUnknownVoices)} onClick={() => void confirm()} className="rounded-lg bg-red-700 px-3 py-2 text-white disabled:opacity-40">{busy ? (zh ? '正在维护…' : 'Working…') : (zh ? '确认清除并重新载入' : 'Confirm removal and reload')}</button>
      </div>}
      {error && <p role="alert" className="break-words text-sm text-red-600">{error}</p>}
    </div>}
  </section>;
}
