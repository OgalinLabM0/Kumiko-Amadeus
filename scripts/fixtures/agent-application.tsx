// Isolated harness entry: production App and store, synthetic settings only.
import { DEFAULT_AI_CONFIG } from '../../services/appConfig';
import { useAppStore } from '../../store';
localStorage.setItem('kumiko_ai_config', JSON.stringify({ ...DEFAULT_AI_CONFIG,
  provider: 'gemini', activeKey: 'primary', apiKey_primary: 'vault:' + 'a'.repeat(64),
  model_main: 'agent-fixture', model_summary: 'agent-fixture', useCustomEndpoint: false }));
localStorage.setItem('kumiko_language', 'zh');
await import('../../index');
useAppStore.getState().setLanguage('zh');
useAppStore.getState().setFlowState('APP');
