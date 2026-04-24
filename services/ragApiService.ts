
export const urlToBase64 = async (url: string): Promise<string | null> => {
    // v2.14.1 I.1: tightened error containment. Previously the outer
    // try/catch swallowed the actual error message — bad URLs / CORS
    // failures / WebView-fetch quirks ended up logged as a generic
    // "Failed to convert URL to Base64" without the reason, making
    // Android log triage painful. We also defensively guard the steps
    // most likely to throw on Capacitor's WebView fetch implementation
    // (some Android WebViews throw on `.blob()` for ICO mime types) and
    // print the real cause without breaking the public no-throw contract.
    if (!url || typeof url !== 'string') {
        console.warn('[Recall] urlToBase64 received invalid url argument:', url);
        return null;
    }
    let response: Response;
    try {
        response = await fetch(url);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[Recall] urlToBase64 fetch threw:', msg, url);
        return null;
    }
    if (!response.ok) {
        console.warn('[Recall] urlToBase64 got non-OK status:', response.status, url);
        return null;
    }
    let blob: Blob;
    try {
        blob = await response.blob();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[Recall] urlToBase64 .blob() threw:', msg, url);
        return null;
    }
    try {
        // P1 #16: this Promise has an onerror handler + 15s timeout so a
        // corrupt blob (or FileReader throwing synchronously) doesn't
        // leave the promise pending and hang the awaiting chat turn.
        return await new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            let settled = false;
            const finish = (value: string | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), 15000);
            reader.onloadend = () => {
                const base64data = (reader.result as string | null) ?? '';
                const raw = base64data.includes(',') ? base64data.split(',')[1] : null;
                finish(raw || null);
            };
            reader.onerror = () => {
                console.warn('[Recall] FileReader error while reading image blob:', url);
                finish(null);
            };
            try {
                reader.readAsDataURL(blob);
            } catch (e) {
                console.warn('[Recall] FileReader.readAsDataURL threw synchronously:', e);
                finish(null);
            }
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[Recall] urlToBase64 inner reader path threw:', msg, url);
        return null;
    }
};

export const uploadImageToBackend = async (base64Image: string, backendUrl: string): Promise<string | null> => {
  try {
    const cleanBaseUrl = backendUrl.replace(/\/+$/, "");
    const uploadUrl = `${cleanBaseUrl}/api/r2-upload`;
    
    const payload = {
        image: base64Image
    };

    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
          'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
        console.error(`[R2 Upload] Server returned ${res.status}`);
        return null;
    }

    const data = await res.json();
    
    if (data && data.url) {
        return data.url;
    }
    
    return null;
  } catch (e) {
    console.error("[R2 Upload] Network Error:", e);
    return null;
  }
};

export const searchRagMemory = async (
    query: string, 
    endpoint: string, 
    userId: string, 
    apiKey?: string
): Promise<string[]> => {
    try {
        const baseUrl = endpoint.replace(/\/+$/, ""); 
        const searchUrl = `${baseUrl}/api/rag/search`;
        
        const payload = {
            query: query,
            userId: userId
        };
        
        const headers: any = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const res = await fetch(searchUrl, { 
            method: 'POST', 
            headers,
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) return [];
        
        const data = await res.json();
        if (Array.isArray(data.results)) return data.results;
        if (Array.isArray(data.memories)) return data.memories.map((m: any) => m.content);
        
        return [];
    } catch (e) {
        console.warn("[RAG] Search failed:", e);
        return [];
    }
};

export const saveRagMemory = async (
    memoryText: string, 
    endpoint: string, 
    userId: string, 
    apiKey?: string
): Promise<boolean> => {
    try {
        const baseUrl = endpoint.replace(/\/+$/, "");
        const addUrl = `${baseUrl}/api/rag/add`;
        
        const headers: any = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        
        const payload = {
            userId,
            text: memoryText,    
            content: memoryText, 
            timestamp: Date.now()
        };

        const res = await fetch(addUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        
        return res.ok;
    } catch (e) {
        console.error("[RAG] Save failed:", e);
        return false;
    }
};
