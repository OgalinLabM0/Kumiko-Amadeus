export const getAppShellStyles = (isDarkMode: boolean) => {
  const containerBg = isDarkMode ? 'bg-[#121212]' : 'bg-[#ffffff]';
  const overlayClass = isDarkMode ? 'scanline-overlay' : 'scanline-overlay opacity-10';
  const sidebarBg = isDarkMode
    ? 'bg-[#161616]/60 md:bg-[#161616]/10 md:backdrop-blur-[3px] border-yellow-900/30'
    : 'bg-white/60 md:bg-white/10 md:backdrop-blur-[3px] border-yellow-600/20';
  const headerBg = isDarkMode ? 'bg-[#1a1a1a]/30 md:bg-[#1a1a1a]/10 border-yellow-900/30' : 'bg-white/40 md:bg-white/10 border-yellow-600/20';
  const textColor = isDarkMode ? 'text-yellow-500' : 'text-[#8b6508]';
  const mutedTextColor = isDarkMode ? 'text-yellow-700' : 'text-[#b8860b]/70';
  const inputAreaBg = isDarkMode ? 'bg-[#141414]/10 border-yellow-900/30' : 'bg-gray-50/10 border-yellow-600/20';
  const inputBoxBg = isDarkMode ? 'bg-[#1e1e1e]/90 text-yellow-100 placeholder-yellow-600/50' : 'bg-white/90 text-gray-800 placeholder-gray-400 border border-gray-200';
  const chatContainerShadow = isDarkMode ? 'shadow-[-5px_0_30px_-5px_rgba(234,179,8,0.3)]' : 'shadow-2xl';
  const headerShadow = isDarkMode ? 'shadow-[0_5px_20px_-5px_rgba(234,179,8,0.2)]' : '';
  const inputShadow = isDarkMode ? 'shadow-[0_-5px_20px_-5px_rgba(234,179,8,0.2)]' : '';
  const avatarPanelBg = isDarkMode ? 'bg-[#121212]' : 'bg-white';
  const avatarGradient = isDarkMode ? 'bg-gradient-to-b from-transparent via-black/30 to-[#121212]' : 'bg-gradient-to-b from-transparent via-white/30 to-white';
  const statusTextColor = isDarkMode ? 'text-yellow-500/80' : 'text-yellow-800/70';

  return {
    containerBg,
    overlayClass,
    sidebarBg,
    headerBg,
    textColor,
    mutedTextColor,
    inputAreaBg,
    inputBoxBg,
    chatContainerShadow,
    headerShadow,
    inputShadow,
    avatarPanelBg,
    avatarGradient,
    statusTextColor
  };
};
