/** Repository configuration identity shared by local and GitHub sources. */

export const CONFIG_PATH = "automations.yml";
export const ABSENT_CONFIG_REVISION = "sha256:absent";

export interface ConfigDocument {
    readonly revision: string;
    readonly text: string;
}
