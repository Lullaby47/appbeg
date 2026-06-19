import Script from 'next/script';

export default function PwaInstallPromptBootstrapScript() {
  return (
    <Script
      id="royal-vip-pwa-install-prompt"
      strategy="beforeInteractive"
    >
      {`
        (function () {
          if (window.__royalVipPwaInstallBootstrapAttached) return;
          window.__royalVipPwaInstallBootstrapAttached = true;
          console.info('[PWA] listener attached');

          window.__royalVipPwaInstallSubscribers = window.__royalVipPwaInstallSubscribers || [];
          window.__royalVipNotifyPwaInstallSubscribers = function () {
            window.__royalVipPwaInstallSubscribers.forEach(function (subscriber) {
              try { subscriber(); } catch (error) {}
            });
          };

          window.addEventListener('beforeinstallprompt', function (event) {
            event.preventDefault();
            window.__royalVipDeferredInstallPrompt = event;
            console.info('[PWA] beforeinstallprompt fired');
            console.info('[PWA] prompt stored');
            window.__royalVipNotifyPwaInstallSubscribers();
          });

          window.addEventListener('appinstalled', function () {
            window.__royalVipPwaInstalled = true;
            window.__royalVipDeferredInstallPrompt = null;
            console.info('[PWA] appinstalled');
            window.__royalVipNotifyPwaInstallSubscribers();
          });
        })();
      `}
    </Script>
  );
}
