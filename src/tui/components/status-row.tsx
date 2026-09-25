import React from "react";
import { Box, Text } from "ink";

export function StatusRow({ label, value, color, dim = false }: {
    label: string;
    value: React.ReactNode;
    color?: "green" | "yellow" | "red";
    dim?: boolean;
}) {
    return <Box>
        <Box width={14}><Text dimColor={dim}>{label}</Text></Box>
        <Text color={color} dimColor={dim}>{value}</Text>
    </Box>;
}
