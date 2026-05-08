const detectOs = () => {
  const userAgentData = navigator.userAgentData;
  const platform = (userAgentData && userAgentData.platform) || navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  const touchPoints = navigator.maxTouchPoints || 0;

  if (/android/i.test(userAgent) || /android/i.test(platform)) return 'android';
  if (/iPad|iPhone|iPod/i.test(userAgent)) return 'ios';
  if (/Mac/i.test(platform) && touchPoints > 1) return 'ios';
  if (/Mac/i.test(platform)) return 'macos';
  if (/Win/i.test(platform)) return 'windows';
  if (/Linux/i.test(platform)) return 'linux';

  return 'unknown';
};

const isStandaloneDisplay = () =>
  navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

const canShareFiles = () => {
  if (!('canShare' in navigator)) return false;
  try {
    const file = new File([''], 'activitypods.txt', { type: 'text/plain' });
    return navigator.canShare({ files: [file] }) === true;
  } catch (error) {
    return false;
  }
};

export const getPlatformCapabilities = () => {
  const os = detectOs();
  const userAgentData = navigator.userAgentData;
  const isMobile = (userAgentData && userAgentData.mobile) ?? (os === 'ios' || os === 'android');

  return {
    os,
    isMobile,
    isStandalone: isStandaloneDisplay(),
    supportsBadging: 'setAppBadge' in navigator && 'clearAppBadge' in navigator,
    supportsShare: 'share' in navigator,
    supportsFileShare: canShareFiles(),
    supportsNotifications: 'Notification' in window,
    supportsInstallPrompt: os === 'android' || os === 'windows' || os === 'linux'
  };
};

export const applyPlatformCapabilities = () => {
  const capabilities = getPlatformCapabilities();
  const root = document.documentElement;

  root.dataset.platformOs = capabilities.os;
  root.dataset.platformMobile = String(capabilities.isMobile);
  root.dataset.platformStandalone = String(capabilities.isStandalone);
  root.classList.add(`platform-${capabilities.os}`);
  root.classList.toggle('platform-mobile', capabilities.isMobile);
  root.classList.toggle('platform-standalone', capabilities.isStandalone);

  return capabilities;
};
