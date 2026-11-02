import React, { useRef, useState } from 'react';
import type { AIConfig, AIProvider, Language, ModelConnectionProfile } from '../../types';
import { resolveModelSessionCredential, storeModelConnectionCredential } from '../../services/roleProfiles';

type Role = NonNullable<AIConfig['modelRoleBindings']> extends Partial<Record<infer K, unknown>> ? K : never;
const roles: Array<{ id: Role; zh: string; en: string }> = [
  { id: 'subject', zh: '主体回复', en: 'Conversation' }, { id: 'understanding', zh: '理解', en: 'Understanding' },
  { id: 'verification', zh: '核验', en: 'Verification' }, { id: 'memory', zh: '记忆整理', en: 'Memory' },
  { id: 'diary', zh: '日记', en: 'Diary' }, { id: 'recall', zh: '回忆', en: 'Recall' },
  { id: 'translation', zh: '语音翻译', en: 'Voice translation' }, { id: 'vision', zh: '视觉', en: 'Vision' },
];
const providers: AIProvider[] = ['gemini','openai','anthropic','deepseek','grok','openrouter','volcengine','dashscope','zhipu','moonshot','qianfan','hunyuan','spark','minimax'];

export function ModelRoleSettings({ config, onChange, language }: { config: AIConfig; onChange: (config: AIConfig) => void; language: Language }) {
  const currentConfig = useRef(config);
  currentConfig.current = config;
  const initialBinding = config.modelRoleBindings?.understanding;
  const initialProfile = config.modelConnections?.find(item => item.id === initialBinding?.profileId);
  const [role, setRole] = useState<Role>('understanding');
  const [provider, setProvider] = useState<AIProvider>(initialProfile?.provider || 'gemini');
  const [url, setUrl] = useState(initialProfile?.baseUrl || '');
  const [model, setModel] = useState(initialBinding?.model || '');
  const [key, setKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const zh = language === 'zh';
  const binding = config.modelRoleBindings?.[role];
  const current = config.modelConnections?.find(item => item.id === binding?.profileId);
  const loadRole = (next: Role) => {
    const nextBinding = config.modelRoleBindings?.[next];
    const profile = config.modelConnections?.find(item => item.id === nextBinding?.profileId);
    setRole(next); setProvider(profile?.provider || 'gemini'); setUrl(profile?.baseUrl || '');
    setModel(nextBinding?.model || ''); setKey(''); setMessage('');
  };
  const save = async () => {
    setBusy(true); setMessage('');
    try {
      if (!model.trim()) throw new Error(zh ? '请填写模型名称。' : 'Enter a model name.');
      const sameDestination = !!current && current.provider === provider && (current.baseUrl || '') === url.trim();
      const reference = key ? await storeModelConnectionCredential(provider, url.trim() || undefined, key) : sameDestination ? current?.credentialRefs.primary : undefined;
      if (currentConfig.current !== config) throw new Error(zh ? '设置已变化，请重新检查后再保存。' : 'Settings changed. Review and save again.');
      if (!reference) throw new Error(zh ? '请为此服务输入密钥。' : 'Enter a key for this service.');
      if (reference.startsWith('session:')) resolveModelSessionCredential(reference, provider, url.trim() || undefined);
      const id = current?.id || crypto.randomUUID();
      const profile: ModelConnectionProfile = { id, provider, baseUrl: url.trim() || undefined,
        credentialRefs: { primary: reference }, activeKey: 'primary', revision: (current?.revision || 0) + 1 };
      onChange({ ...config, modelConnections: [...(config.modelConnections || []).filter(item => item.id !== id), profile],
        modelRoleBindings: { ...config.modelRoleBindings, [role]: { profileId: id, model: model.trim(), revision: (binding?.revision || 0) + 1 } } });
      setKey(''); setMessage(zh ? '已设置，请保存页面配置。' : 'Configured. Save the page settings.');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const inherit = () => {
    const bindings = { ...config.modelRoleBindings }; delete bindings[role];
    onChange({ ...config, modelRoleBindings: bindings });
    setKey(''); setMessage(zh ? '已恢复继承，请保存页面配置。' : 'Inheritance restored. Save the page settings.');
  };
  return <details className="cfg-glass rounded-xl p-4 space-y-3">
    <summary className="cursor-pointer font-semibold">{zh ? '高级：为工位单独配置模型' : 'Advanced: separate models by role'}</summary>
    <p className="text-sm opacity-75">{zh ? '默认继承现有设置。连接与密钥按服务地址绑定；浏览器密钥仅保留本次会话。' : 'Roles inherit existing settings by default. Keys are bound to their service; browser keys last for this session.'}</p>
    <p className="text-sm opacity-75">{zh ? '独立工位尚未进行能力验证；普通连接测试不能证明工具调用、图像理解或回答质量。' : 'Separate roles have not been capability-tested. A connection check does not prove tool use, image understanding or response quality.'}</p>
    <div className="grid gap-2">
      <label>{zh ? '工位' : 'Role'} <select className="w-full text-black" value={role} onChange={e => loadRole(e.target.value as Role)}>{roles.map(item => <option key={item.id} value={item.id}>{zh ? item.zh : item.en}</option>)}</select></label>
      <label>{zh ? '服务商' : 'Provider'} <select className="w-full text-black" value={provider} onChange={e => setProvider(e.target.value as AIProvider)}>{providers.map(item => <option key={item}>{item}</option>)}</select></label>
      <label>{zh ? '自定义请求地址（留空使用默认；兼容接口填写完整请求地址）' : 'Custom request URL (optional; use the full compatible endpoint)'} <input className="w-full text-black" value={url} onChange={e => setUrl(e.target.value)} /></label>
      <label>{zh ? '模型' : 'Model'} <input className="w-full text-black" value={model} onChange={e => setModel(e.target.value)} /></label>
      <label>{zh ? '密钥（更换地址时必填）' : 'API key (required for a new endpoint)'} <input className="w-full text-black" type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" /></label>
      <div className="flex gap-3"><button type="button" disabled={busy} onClick={() => void save()}>{zh ? '设置工位' : 'Set role'}</button><button type="button" disabled={busy} onClick={inherit}>{zh ? '恢复继承' : 'Use inherited settings'}</button></div>
      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  </details>;
}
