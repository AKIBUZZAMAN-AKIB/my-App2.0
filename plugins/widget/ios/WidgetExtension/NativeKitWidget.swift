import WidgetKit
import SwiftUI

/// A machine readable value pushed from the web app via NativeKit.widget.setConfig({kind:"nativekit-widget", config}).
struct NativeKitWidgetEntry: TimelineEntry {
    let date: Date
    let title: String
    let value: String
    let subtitle: String
    let accentColor: Color
    let backgroundColor: Color

    static let empty = NativeKitWidgetEntry(
        date: Date(),
        title: "NativeKit",
        value: "—",
        subtitle: "",
        accentColor: Color(red: 0.31, green: 0.76, blue: 0.97),
        backgroundColor: Color(red: 0.06, green: 0.09, blue: 0.16))
}

struct NativeKitWidget: Widget {
    let kind: String = "nativekit-widget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NativeKitWidgetProvider()) { entry in
            NativeKitWidgetView(entry: entry)
        }
        .configurationDisplayName("NativeKit")
        .description("NativeKit config-driven home screen widget.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct NativeKitWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> NativeKitWidgetEntry { .empty }

    func getSnapshot(in context: Context, completion: @escaping (NativeKitWidgetEntry) -> Void) {
        completion(load())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NativeKitWidgetEntry>) -> Void) {
        let entry = load()
        // Refresh an hour later, or sooner if the app pushes a new value via reloadAllTimelines().
        let next = Calendar.current.date(byAdding: .hour, value: 1, to: Date()) ?? Date()
        completion(Timeline(entries: [entry], policy: .after(next)))
    }

    private func load() -> NativeKitWidgetEntry {
        // Must match the App Group used by the app's NativeKitWidgetPlugin.
        let suite = "group." + (Bundle.main.bundleIdentifier ?? "")
        guard let defaults = UserDefaults(suiteName: suite),
              let raw = defaults.data(forKey: "nativekit.widget.nativekit-widget") else {
            return .empty
        }
        guard let config = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            return .empty
        }
        return NativeKitWidgetEntry(
            date: Date(),
            title: config["title"] as? String ?? "NativeKit",
            value: config["value"] as? String ?? "—",
            subtitle: config["subtitle"] as? String ?? "",
            accentColor: color(from: config["accentColor"] as? String, fallback: Color(red: 0.31, green: 0.76, blue: 0.97)),
            backgroundColor: color(from: config["backgroundColor"] as? String, fallback: Color(red: 0.06, green: 0.09, blue: 0.16)))
    }

    private func color(from hex: String?, fallback: Color) -> Color {
        guard let hex, hex.hasPrefix("#"), hex.count == 7 else { return fallback }
        let r = Double(Int(hex.dropFirst().prefix(2), radix: 16) ?? 0) / 255.0
        let g = Double(Int(hex.dropFirst().dropFirst().prefix(2), radix: 16) ?? 0) / 255.0
        let b = Double(Int(hex.suffix(2), radix: 16) ?? 0) / 255.0
        return Color(red: r, green: g, blue: b)
    }
}

struct NativeKitWidgetView: View {
    let entry: NativeKitWidgetEntry

    @Environment(\.widgetFamily) private var family

    var body: some View {
        ZStack {
            entry.backgroundColor
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.value)
                    .font(.system(size: family == .systemSmall ? 34 : 44, weight: .bold, design: .rounded))
                    .foregroundColor(entry.accentColor)
                    .minimumScaleFactor(0.5)
                Text(entry.title)
                    .font(.headline)
                    .foregroundColor(.white)
                    .lineLimit(1)
                if !entry.subtitle.isEmpty {
                    Text(entry.subtitle)
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.8))
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
        .widgetBackground(entry.backgroundColor)
    }
}

// containerBackground is iOS 17+; deployment target is iOS 15, so use the modern
// modifier when available and fall back to a plain background otherwise.
extension View {
    @ViewBuilder
    func widgetBackground(_ color: Color) -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(for: .widget) { color }
        } else {
            self.background(color)
        }
    }
}
