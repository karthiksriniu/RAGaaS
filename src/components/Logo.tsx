/**
 * MyBizCare mark - a rounded square (matching Kiowa's large-container
 * radius token) holding an abstract chat-bubble-and-check glyph: the
 * "chat" half stands for the AI advisory conversation, the check for the
 * expert-verified answer/escalation path. Deep-teal gradient, matching the
 * Kiowa Design System's brand primary (#006874) rather than reusing
 * Kiowa's own literal mark, which belongs to Kiowa specifically.
 */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="mybizcare-mark" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22BCCE" />
          <stop offset="1" stopColor="#006874" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="36" height="36" rx="11.2" fill="url(#mybizcare-mark)" />
      <path
        d="M12 15.5C12 13.567 13.567 12 15.5 12H24.5C26.433 12 28 13.567 28 15.5V20.5C28 22.433 26.433 24 24.5 24H19L15 27.5V24H15.5C13.567 24 12 22.433 12 20.5V15.5Z"
        fill="white"
        fillOpacity="0.96"
      />
      <path
        d="M16.5 18.2L18.6 20.3L23 15.8"
        stroke="#006874"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default Logo;
