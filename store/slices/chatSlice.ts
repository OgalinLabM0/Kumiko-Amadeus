import type { StateCreator } from 'zustand';
import type { Message, MissedMessageAlert } from '../../types';

export interface ChatSlice {
  messages: Message[];
  inputValue: string;
  selectedImage: string | null;
  selectedImageId: string | null;
  replyingToMsg: Message | null;
  highlightedMessageId: string | null;
  messageAlerts: MissedMessageAlert[];

  setMessages: (v: Message[] | ((prev: Message[]) => Message[])) => void;
  setInputValue: (v: string | ((prev: string) => string)) => void;
  setSelectedImage: (v: string | null) => void;
  setSelectedImageId: (v: string | null) => void;
  setReplyingToMsg: (v: Message | null) => void;
  setHighlightedMessageId: (v: string | null) => void;
  setMessageAlerts: (v: MissedMessageAlert[] | ((prev: MissedMessageAlert[]) => MissedMessageAlert[])) => void;
}

export const createChatSlice: StateCreator<ChatSlice, [], [], ChatSlice> = (set) => ({
  messages: [],
  inputValue: '',
  selectedImage: null,
  selectedImageId: null,
  replyingToMsg: null,
  highlightedMessageId: null,
  messageAlerts: [],

  setMessages: (v) => set((s) => ({ messages: typeof v === 'function' ? v(s.messages) : v })),
  setInputValue: (v) => set((s) => ({ inputValue: typeof v === 'function' ? v(s.inputValue) : v })),
  setSelectedImage: (v) => set({ selectedImage: v }),
  setSelectedImageId: (v) => set({ selectedImageId: v }),
  setReplyingToMsg: (v) => set({ replyingToMsg: v }),
  setHighlightedMessageId: (v) => set({ highlightedMessageId: v }),
  setMessageAlerts: (v) => set((s) => ({ messageAlerts: typeof v === 'function' ? v(s.messageAlerts) : v })),
});
