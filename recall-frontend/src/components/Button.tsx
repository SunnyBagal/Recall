import type { ButtonHTMLAttributes, ReactElement } from "react";

type Variant = "primary" | "secondary";
type Size = "sm" | "md" | "lg";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant: Variant;
  size: Size;
  text: string | number;
  startIcon?: ReactElement;
  endIcon?: ReactElement;
}

const variantStyles: Record<Variant, string> = {
  primary: "bg-black text-white hover:bg-gray-800 active:bg-gray-900",
  secondary: "bg-gray-100 text-black hover:bg-gray-200 active:bg-gray-300",
};

const sizeStyles: Record<Size, string> = {
  sm: "px-2 py-1 text-sm",
  md: "px-4 py-2 text-md",
  lg: "px-6 py-3 text-lg",
};

const baseStyles =
  "rounded-xl inline-flex items-center justify-center gap-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-black disabled:opacity-50 disabled:cursor-not-allowed";

export const Button = ({
  variant,
  size,
  text,
  startIcon,
  endIcon,
  className = "",
  type = "button",
  ...rest
}: ButtonProps) => {
  return (
    <button
      type={type}
      className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...rest}
    >
        {startIcon}
        {text}
        {endIcon}
    </button>
  );
};

export default Button;
