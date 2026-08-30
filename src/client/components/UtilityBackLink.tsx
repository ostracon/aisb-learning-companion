import { Link } from "react-router-dom";

/** Consistent, quiet navigation from utility surfaces back to the main workspace. */
export function UtilityBackLink() {
  return (
    <Link className="utility-back-link" to="/">
      <span aria-hidden="true">←</span>
      Back to workspace
    </Link>
  );
}
