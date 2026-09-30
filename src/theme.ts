/** One-hand, high-contrast palette: dark capture surface, light review surface. */
export const colors = {
  // Capture (dark)
  camBg: '#000000',
  camChrome: 'rgba(18,18,20,0.78)',
  camText: '#FFFFFF',
  camTextDim: 'rgba(255,255,255,0.62)',
  camGuide: 'rgba(255,255,255,0.35)',
  camLocked: '#34D399',

  // Review (light)
  bg: '#F6F7F9',
  surface: '#FFFFFF',
  border: '#E4E7EC',
  text: '#101828',
  textDim: '#667085',

  // Status
  correct: '#12B76A',
  incorrect: '#F04438',
  partial: '#2E90FA',
  review: '#F79009',

  accent: '#6938EF',
  accentSoft: '#F4F0FF',
} as const;

export const statusColor = (s: string): string => {
  switch (s) {
    case 'correct':
      return colors.correct;
    case 'incorrect':
      return colors.incorrect;
    case 'partial':
      return colors.partial;
    default:
      return colors.review;
  }
};

export const statusLabel = (s: string): string => {
  switch (s) {
    case 'correct':
      return 'Correct';
    case 'incorrect':
      return 'Incorrect';
    case 'partial':
      return 'Partial credit';
    default:
      return 'Needs review';
  }
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 18, pill: 999 } as const;

/** Minimum comfortable one-hand touch target. */
export const HIT = 48;
