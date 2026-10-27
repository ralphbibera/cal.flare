export default function UnsupportedLink() {
  throw new Error("The native-button reference must not render a Next.js link");
}

export function Tooltip() {
  throw new Error("The native-button reference must not render a tooltip");
}
