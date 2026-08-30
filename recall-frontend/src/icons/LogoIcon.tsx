import { iconSizeVariants, type IconProps } from "."

interface LogoIconProps extends IconProps {
  /** Text-color class the mark is drawn in — the paths use currentColor. */
  className?: string;
}

// Defaults to white: the app sits on the dark bg-mybackg everywhere, and
// relying on inherited currentColor made the mark render black (invisible) on
// any screen whose header didn't happen to set a text color — which is what
// happened on the shared-board page.
export const LogoIcon = ({ size, className = "text-white" }: LogoIconProps) => (
  <svg
    className={`${iconSizeVariants[size]} ${className}`}
    viewBox="0 0 24 24"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Recall"
  >
    
    <path d="M 9 2 L 22 2 L 22 15 L 9 15 Z" fillOpacity="0.35" />
    
    <path d="M 2 9 L 15 9 L 15 22 L 2 22 Z" />
  </svg>
);
