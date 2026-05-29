import { iconSizeVariants, type IconProps } from "."

export const SidebarToggle = (props: IconProps) => {
  return (
    <svg viewBox="-0.5 -0.5 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" id="Sidebar-Collapse--Streamline-Iconoir" className={iconSizeVariants[props.size]}>
      <path d="M12.7769375 14.284625H2.2230625c-0.8326875 0 -1.5076875 -0.675 -1.5076875 -1.5076875l0 -10.553875c0 -0.8326875 0.675 -1.5076875 1.5076875 -1.5076875h10.553875c0.8326875 0 1.5076875 0.675 1.5076875 1.5076875v10.553875c0 0.8326875 -0.675 1.5076875 -1.5076875 1.5076875Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1"></path>
      <path d="M3.9192500000000003 5.9923125 2.6 7.5l1.3192499999999998 1.5076875" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1"></path>
      <path d="M5.615375 14.284625V0.7153750000000001" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1"></path>
    </svg>
  )
}