import { getLanguage } from "@excalidraw/excalidraw/i18n";

export const timeAgo = (date: string | number | Date): string => {
  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(getLanguage().code, {
    numeric: "auto",
  });

  if (diffInSeconds < 10) {
    return rtf.format(0, "second");
  }
  if (diffInSeconds < 60) {
    return rtf.format(-diffInSeconds, "second");
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return rtf.format(-diffInMinutes, "minute");
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return rtf.format(-diffInHours, "hour");
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) {
    return rtf.format(-diffInDays, "day");
  }

  return past.toLocaleDateString(getLanguage().code);
};
