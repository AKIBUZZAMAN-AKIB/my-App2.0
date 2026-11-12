import Foundation
import UserNotifications
#if canImport(AlarmKit)
import AlarmKit
import SwiftUI

@available(iOS 26.0, *)
private struct NativeKitAlarmMetadata: AlarmMetadata {}
#endif

final class NativeKitAlarmAdapter {
    private let defaultsKey = "nativekit.alarms"

    func capabilities() -> [String: Any] {
        if #available(iOS 26.0, *) {
            #if canImport(AlarmKit)
            return [
                "platform": "ios",
                "exact": AlarmManager.shared.authorizationState == .authorized,
                "fullScreen": false,
                "alarmKit": true,
                "authorization": String(describing: AlarmManager.shared.authorizationState),
                "fallback": AlarmManager.shared.authorizationState == .authorized ? "none" : "local-notification",
            ]
            #endif
        }
        return ["platform": "ios", "exact": false, "fullScreen": false, "alarmKit": false, "authorization": "unavailable", "fallback": "local-notification"]
    }

    func requestAuthorization(completion: @escaping (Result<Void, Error>) -> Void) {
        if #available(iOS 26.0, *) {
            #if canImport(AlarmKit)
            Task {
                do {
                    let status = try await AlarmManager.shared.requestAuthorization()
                    if status == .authorized { completion(.success(())) }
                    else { completion(.failure(NSError(domain: "NativeKitAlarm", code: 1, userInfo: [NSLocalizedDescriptionKey: "AlarmKit permission was not granted"]))) }
                } catch { completion(.failure(error)) }
            }
            return
            #endif
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error { completion(.failure(error)) }
            else if granted { completion(.success(())) }
            else { completion(.failure(NSError(domain: "NativeKitAlarm", code: 2, userInfo: [NSLocalizedDescriptionKey: "Notification permission was not granted"]))) }
        }
    }

    func schedule(options: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let id = options["id"] as? String,
              let title = options["title"] as? String,
              let milliseconds = (options["at"] as? NSNumber)?.doubleValue else {
            completion(.failure(NSError(domain: "NativeKitAlarm", code: 3, userInfo: [NSLocalizedDescriptionKey: "id, title and numeric at are required"])))
            return
        }
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        guard date > Date() else {
            completion(.failure(NSError(domain: "NativeKitAlarm", code: 4, userInfo: [NSLocalizedDescriptionKey: "Alarm time must be in the future"])))
            return
        }
        var record = options
        let platformId = UUID(uuidString: id) ?? UUID()
        record["platformId"] = platformId.uuidString
        record["scheduledAt"] = milliseconds
        record["exact"] = false
        record["platformMode"] = "local-notification-fallback"

        if #available(iOS 26.0, *) {
            #if canImport(AlarmKit)
            Task {
                do {
                    var state = AlarmManager.shared.authorizationState
                    if state == .notDetermined { state = try await AlarmManager.shared.requestAuthorization() }
                    if state == .authorized {
                        let stop = AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle.fill")
                        let alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title), stopButton: stop)
                        let attributes = AlarmAttributes<NativeKitAlarmMetadata>(presentation: AlarmPresentation(alert: alert), tintColor: .blue)
                        let configuration = AlarmManager.AlarmConfiguration.alarm(schedule: .fixed(date), attributes: attributes)
                        _ = try await AlarmManager.shared.schedule(id: platformId, configuration: configuration)
                        record["exact"] = true
                        record["platformMode"] = "alarmkit"
                        self.put(record, id: id)
                        completion(.success(record))
                        return
                    }
                    self.scheduleNotification(record: record, id: id, title: title, date: date, completion: completion)
                } catch {
                    self.scheduleNotification(record: record, id: id, title: title, date: date, completion: completion)
                }
            }
            return
            #endif
        }
        scheduleNotification(record: record, id: id, title: title, date: date, completion: completion)
    }

    private func scheduleNotification(record: [String: Any], id: String, title: String, date: Date, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error { completion(.failure(error)); return }
            guard granted else {
                completion(.failure(NSError(domain: "NativeKitAlarm", code: 5, userInfo: [NSLocalizedDescriptionKey: "AlarmKit unavailable/denied and Local Notification permission was not granted"])))
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = record["body"] as? String ?? ""
            content.sound = .default
            if #available(iOS 15.0, *) { content.interruptionLevel = .timeSensitive }
            let repeatMinutes = (record["repeatIntervalMinutes"] as? NSNumber)?.doubleValue ?? 0
            let trigger: UNNotificationTrigger
            if repeatMinutes > 0 {
                trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(60, repeatMinutes * 60), repeats: true)
            } else {
                trigger = UNCalendarNotificationTrigger(dateMatching: Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date), repeats: false)
            }
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: trigger)) { error in
                if let error { completion(.failure(error)) }
                else { self.put(record, id: id); completion(.success(record)) }
            }
        }
    }

    func cancel(id: String) throws {
        if let record = records()[id], let raw = record["platformId"] as? String, let uuid = UUID(uuidString: raw) {
            if #available(iOS 26.0, *) {
                #if canImport(AlarmKit)
                try? AlarmManager.shared.cancel(id: uuid)
                #endif
            }
        }
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
        remove(id: id)
    }

    func stop(id: String?) {
        let all = records()
        let selected: [String: [String: Any]]
        if let id, let record = all[id] { selected = [id: record] }
        else { selected = all }
        if #available(iOS 26.0, *) {
            #if canImport(AlarmKit)
            for (_, record) in selected {
                if let raw = record["platformId"] as? String, let uuid = UUID(uuidString: raw) { try? AlarmManager.shared.stop(id: uuid) }
            }
            #endif
        }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(selected.keys))
    }

    func list() -> [[String: Any]] { Array(records().values) }

    private func records() -> [String: [String: Any]] {
        UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: [String: Any]] ?? [:]
    }

    private func put(_ record: [String: Any], id: String) {
        var all = records(); all[id] = record; UserDefaults.standard.set(all, forKey: defaultsKey)
    }

    private func remove(id: String) {
        var all = records(); all.removeValue(forKey: id); UserDefaults.standard.set(all, forKey: defaultsKey)
    }
}
