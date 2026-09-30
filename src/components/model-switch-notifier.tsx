'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

interface SystemNotification {
  id: number;
  type: string;
  message: string;
  created_at: string;
  read: number;
}

export function ModelSwitchNotifier() {
  const isCheckingRef = useRef(false);

  const checkNotifications = async () => {
    if (isCheckingRef.current) return;
    isCheckingRef.current = true;
    try {
      const res = await fetch('/api/system/notifications');
      if (!res.ok) return;
      const data = await res.json();
      const notifications: SystemNotification[] = data.notifications || [];

      if (notifications.length > 0) {
        const idsToAck: number[] = [];
        for (const n of notifications) {
          idsToAck.push(n.id);
          // Pop up simpler, clean toast message
          if (n.type === 'model_switch') {
            toast.info(n.message, {
              duration: 7000,
              description: 'AI model updated automatically to ensure uninterrupted processing.',
            });
          } else {
            toast(n.message, { duration: 6000 });
          }
        }

        // Acknowledge notifications so they don't pop up again
        await fetch('/api/system/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: idsToAck }),
        });
      }
    } catch {
      // Ignore background fetch errors
    } finally {
      isCheckingRef.current = false;
    }
  };

  useEffect(() => {
    // Initial check
    checkNotifications();

    // Check periodically every 5 seconds
    const interval = setInterval(checkNotifications, 5000);

    // Check on window focus
    const onFocus = () => {
      checkNotifications();
    };
    window.addEventListener('focus', onFocus);

    // Check on custom event
    const onCustomEvent = () => {
      checkNotifications();
    };
    window.addEventListener('hireme:model-switch', onCustomEvent);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('hireme:model-switch', onCustomEvent);
    };
  }, []);

  return null;
}
