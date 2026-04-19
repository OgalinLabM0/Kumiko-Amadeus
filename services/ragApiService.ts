
export const urlToBase64 = async (url: string): Promise<string | null> => {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.warn('[Recall] urlToBase64 got non-OK status:', response.status, url);
            return null;
        }
        const blob = await response.blob();
        // P1 #16: previously this Promise had no onerror handler and no timeout, so a
        // corrupt blob (or FileReader throwing synchronously) would leave the promise
        // pending forever and hang whatever chat turn was awaiting it.
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
        console.warn("[Recall] Failed to convert URL to Base64:", url);
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
