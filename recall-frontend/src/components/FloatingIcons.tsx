import type { ReactElement } from "react";
import {
  YoutubeMark,
  XMark,
  RedditMark,
  GithubMark,
  InstagramMark,
  MediumMark,
  NotionMark,
  SubstackMark,
  HackerNewsMark,
  StackOverflowMark,
  LinkedinMark,
  SpotifyMark,
  FigmaMark,
  DribbbleMark,
  DiscordMark,
  TwitchMark,
  TiktokMark,
  ThreadsMark,
  PinterestMark,
  SlackMark,
  RaindropMark,
  ProductHuntMark,
  SoundcloudMark,
  DevtoMark,
} from "../icons/brands";

type Tier = "core" | "wide" | "ultra";

interface FloatingMark {
  mark: ReactElement;
  /** position as a percentage of the backdrop */
  x: number;
  y: number;
  /** chip edge length in px */
  size: number;
  tilt: number;
  delay: number;
  duration: number;
  opacity: number;
  tier: Tier;
}

// Kept clear of the middle column so the auth card never sits on top of a chip.
const MARKS: FloatingMark[] = [
  { mark: <YoutubeMark />, x: 8, y: 16, size: 64, tilt: -8, delay: 0, duration: 13, opacity: 0.6, tier: "core" },
  { mark: <GithubMark />, x: 84, y: 12, size: 58, tilt: 10, delay: 1.4, duration: 15, opacity: 0.55, tier: "core" },
  { mark: <RedditMark />, x: 17, y: 74, size: 60, tilt: 7, delay: 2.6, duration: 14, opacity: 0.55, tier: "core" },
  { mark: <XMark />, x: 88, y: 68, size: 50, tilt: -6, delay: 0.8, duration: 16, opacity: 0.5, tier: "core" },
  { mark: <NotionMark />, x: 46, y: 4, size: 46, tilt: 6, delay: 3.2, duration: 12, opacity: 0.4, tier: "core" },
  { mark: <SpotifyMark />, x: 52, y: 92, size: 52, tilt: -10, delay: 1.9, duration: 15, opacity: 0.45, tier: "core" },

  { mark: <InstagramMark />, x: 24, y: 36, size: 46, tilt: 12, delay: 2.1, duration: 17, opacity: 0.4, tier: "wide" },
  { mark: <MediumMark />, x: 74, y: 34, size: 42, tilt: -12, delay: 3.7, duration: 14, opacity: 0.38, tier: "wide" },
  { mark: <SubstackMark />, x: 12, y: 52, size: 38, tilt: 9, delay: 4.5, duration: 18, opacity: 0.36, tier: "wide" },
  { mark: <HackerNewsMark />, x: 79, y: 86, size: 40, tilt: -5, delay: 0.4, duration: 13, opacity: 0.36, tier: "wide" },
  { mark: <StackOverflowMark />, x: 27, y: 91, size: 44, tilt: -9, delay: 5.1, duration: 16, opacity: 0.4, tier: "wide" },
  { mark: <LinkedinMark />, x: 70, y: 54, size: 40, tilt: 8, delay: 2.9, duration: 19, opacity: 0.34, tier: "wide" },
  { mark: <FigmaMark />, x: 5, y: 88, size: 42, tilt: 14, delay: 1.2, duration: 15, opacity: 0.38, tier: "wide" },
  { mark: <TiktokMark />, x: 92, y: 42, size: 38, tilt: -11, delay: 4.1, duration: 17, opacity: 0.34, tier: "wide" },

  { mark: <DiscordMark />, x: 33, y: 12, size: 40, tilt: -7, delay: 3.4, duration: 16, opacity: 0.3, tier: "ultra" },
  { mark: <TwitchMark />, x: 63, y: 18, size: 36, tilt: 11, delay: 5.6, duration: 14, opacity: 0.3, tier: "ultra" },
  { mark: <ThreadsMark />, x: 19, y: 24, size: 34, tilt: 5, delay: 6.2, duration: 18, opacity: 0.28, tier: "ultra" },
  { mark: <PinterestMark />, x: 90, y: 26, size: 36, tilt: -13, delay: 2.4, duration: 15, opacity: 0.3, tier: "ultra" },
  { mark: <SlackMark />, x: 3, y: 40, size: 38, tilt: 8, delay: 4.8, duration: 20, opacity: 0.3, tier: "ultra" },
  { mark: <RaindropMark />, x: 82, y: 54, size: 34, tilt: -4, delay: 6.8, duration: 13, opacity: 0.28, tier: "ultra" },
  { mark: <ProductHuntMark />, x: 36, y: 82, size: 36, tilt: 10, delay: 5.3, duration: 17, opacity: 0.3, tier: "ultra" },
  { mark: <SoundcloudMark />, x: 66, y: 76, size: 38, tilt: -8, delay: 3.9, duration: 16, opacity: 0.28, tier: "ultra" },
  { mark: <DevtoMark />, x: 95, y: 8, size: 34, tilt: 6, delay: 7.4, duration: 19, opacity: 0.26, tier: "ultra" },
  { mark: <DribbbleMark />, x: 8, y: 66, size: 36, tilt: -10, delay: 1.7, duration: 14, opacity: 0.3, tier: "ultra" },
];

const tierVisibility: Record<Tier, string> = {
  core: "",
  wide: "hidden md:block",
  ultra: "hidden xl:block",
};

export const FloatingIcons = () => {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* warm halo so the card reads as lit rather than pasted on */}
      <div className="absolute left-1/2 top-1/2 h-[46rem] w-[46rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-myred/10 blur-[120px]" />

      {MARKS.map(({ mark, x, y, size, tilt, delay, duration, opacity, tier }, i) => (
        <div
          key={i}
          className={`floating-mark absolute ${tierVisibility[tier]}`}
          style={{
            left: `${x}%`,
            top: `${y}%`,
            width: size,
            height: size,
            opacity,
            animationDelay: `-${delay}s`,
            animationDuration: `${duration}s`,
            ["--tilt" as string]: `${tilt}deg`,
            ["--drift" as string]: `${i % 2 === 0 ? -1 : 1}`,
          }}
        >
          <div className="flex h-full w-full -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border border-white/10 bg-white/5 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-[2px]">
            <div className="flex h-[55%] w-[55%] items-center justify-center [&>svg]:h-full [&>svg]:w-full">
              {mark}
            </div>
          </div>
        </div>
      ))}

      {/* fade the field into the page edges */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_62%,var(--color-mybackg)_100%)]" />
    </div>
  );
};

export default FloatingIcons;
