import { iconSizeVariants, type IconProps } from "."

export const LogoIcon = ({ size }: IconProps) => (
  <svg
    className={iconSizeVariants[size]}
    viewBox="0 0 24 24"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    
    <path d="M 9 2 L 22 2 L 22 15 L 9 15 Z" fillOpacity="0.35" />
    
    <path d="M 2 9 L 15 9 L 15 22 L 2 22 Z" />
  </svg>
);
