import type { GptModelsResponse } from "../api/types.js";
import type { SettingsField, SettingsFormState, SettingsValues } from "./settings-state.js";

export interface SettingsPageProps {
    form: SettingsFormState;
    saving: boolean;
    fieldError(field: SettingsField): string | undefined;
    edit<Field extends SettingsField>(field: Field, value: SettingsValues[Field]): void;
}

export interface ModelCatalogProps {
    catalog: GptModelsResponse | null;
    loading: boolean;
    error: string | null;
    refresh(): void;
}
