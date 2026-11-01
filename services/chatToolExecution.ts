import type { AIConfig, Language } from '../types';
import { callVisionHelper, type ChatToolOutput } from './llmProviderService';
import { imageService } from './imageService';
import { searchLocalRagMemoryDetailed } from './localRagService';
import { queryKnownUserLocationWeather } from './userKnownLocation';

export const createChatToolExecutor = (
  config: AIConfig,
  language: Language,
  groundingSources: { title: string; uri: string }[],
  allowedTools: readonly string[],
) => async (call: ChatToolOutput['call'], signal: AbortSignal): Promise<ChatToolOutput> => {
  const reminder = language === 'zh'
    ? '请先输出 [[System_Log]]（Kumiko_Thought、Emotion），再回复用户。工具失败或未执行的内容必须保留为未知。'
    : 'Output [[System_Log]] (Kumiko_Thought, Emotion) before your reply. Failed or unexecuted queries remain unknown.';
  const finish = (result: Record<string, any>, image?: ChatToolOutput['image']): ChatToolOutput => ({
    call, result: { ...result, _reminder: reminder }, ...(image ? { image } : {}),
  });
  if (!allowedTools.includes(call.name)) return finish({ success: false, error: `Tool is not enabled: ${call.name}` });
  if (call.argumentError) return finish({ success: false, error: call.argumentError });
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    return finish({ success: false, error: 'Tool arguments must be an object' });
  }
  try {
    if (call.name === 'query_known_user_weather') {
      if (Object.keys(call.args).length > 0) return finish({ success: false, status: 'unknown', error: 'This tool takes no arguments; only the user-disclosed saved place may be queried.' });
      return finish(await queryKnownUserLocationWeather(signal));
    }
    if (call.name === 'search_internet') {
      const query = call.args.query;
      if (typeof query !== 'string' || !query.trim()) return finish({ success: false, error: 'query must be a non-empty string' });
      const apiKey = localStorage.getItem('tavily_api_key');
      if (!apiKey) return finish({ success: false, error: '请先在设置中填写 Tavily API Key 以启用搜索' });
      const response = await fetch(`https://search.omkk.org/api/search?q=${encodeURIComponent(query.trim())}`, {
        headers: { 'x-api-key': apiKey }, signal,
      });
      if (!response.ok) throw new Error(`Search server returned ${response.status}`);
      const data = await response.json();
      if (Array.isArray(data.results)) {
        for (const hit of data.results.slice(0, 5)) {
          if (hit && typeof hit.url === 'string' && hit.url.trim() && !groundingSources.some(source => source.uri === hit.url)) {
            groundingSources.push({ title: typeof hit.title === 'string' && hit.title.trim() ? hit.title : hit.url, uri: hit.url });
          }
        }
      }
      return finish({ success: true, results: data.results || [] });
    }
    if (call.name === 'recall_memory') {
      const query = call.args.query;
      if (typeof query !== 'string' || !query.trim()) return finish({ success: false, error: 'query must be a non-empty string' });
      const recall = await searchLocalRagMemoryDetailed(query.trim(), 5, undefined, 'semantic_recall', undefined, { suppressEmptyWarning: true });
      const blocks = recall.blocks ?? [];
      return finish({ success: true, blocks, count: blocks.length, timeHint: call.args.timeHint || null });
    }
    if (call.name === 'view_historical_image') {
      const imageId = call.args.imageId;
      if (typeof imageId !== 'string' || imageId.length <= 5 || imageId.length >= 100 || !/^[a-zA-Z0-9_\-:.]+$/.test(imageId)) {
        return finish({ success: false, error: 'Invalid image ID; provide a single image ID' });
      }
      const data = await imageService.getImage(imageId);
      if (!data) return finish({ success: false, error: 'Image not found in local database' });
      const match = data.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
      if (!match) return finish({ success: false, error: 'Invalid image data format' });
      const image = { mimeType: match[1], data: match[2].replace(/[\r\n]/g, '') };
      if (config.useVisionHelper) {
        const description = await callVisionHelper(config, image.data, image.mimeType, language);
        if (!description?.trim() || /\[Vision Helper returned no description\]/i.test(description)) {
          return finish({ success: false, error: 'Vision helper did not provide image evidence' });
        }
        return finish({ success: true, imageId, description, evidence: 'vision_helper_description' });
      }
      return finish({ success: true, imageId, evidence: 'attached_image' }, image);
    }
    return finish({ success: false, error: `Unknown tool: ${call.name}` });
  } catch (error) {
    if (signal.aborted) throw error;
    return finish({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
};
